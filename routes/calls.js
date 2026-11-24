/**
 * Calls: lifecycle + STUN-only WebRTC signaling relay.
 * Rooms are just call ids. Media flows peer-to-peer via RTCPeerConnection on
 * the client; the server only stores/relays SDP + ICE candidates.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { requireUser } from '../auth.js';
import { sendCallPush } from './platform.js';

const router = Router();
const asIso = (v) => (v instanceof Date ? v.toISOString() : String(v));
const rid = (p = '') => `${p}${crypto.randomUUID()}`;

async function callFor(id, userId) {
  const { rows } = await query(
    `SELECT c.id, c.kind, c.is_group, c.status, c.started_at, c.ended_at, c.room_code, c.created_by, c.answered_at
       FROM calls c
       JOIN call_participants cp ON cp.call_id = c.id AND cp.user_id = $2
      WHERE c.id = $1`,
    [id, userId],
  );
  return rows[0] ?? null;
}

async function participantOutcomes(callId) {
  const { rows } = await query(
    `SELECT cp.user_id, cp.outcome, cp.left_at, pr.username, pr.display_name, pr.avatar_color
       FROM call_participants cp JOIN profiles pr ON pr.user_id = cp.user_id
      WHERE cp.call_id = $1`,
    [callId],
  );
  return rows;
}

/** POST /calls — create a call and ring the given users. */
router.post('/calls', requireUser, async (req, res, next) => {
  try {
    const me = req.user.id;
    const kind = ['voice', 'video'].includes(String(req.body?.kind)) ? String(req.body.kind) : 'voice';
    const targetIds = [...new Set(Array.isArray(req.body?.targetUserIds) ? req.body.targetUserIds.map(String) : [])]
      .filter((t) => t && t !== me)
      .slice(0, 50);
    if (targetIds.length === 0) return res.status(400).json({ message: 'Pick at least one person to call.' });
    const { rows: targets } = await query(
      'SELECT user_id, who_can_call, is_banned FROM profiles WHERE user_id = ANY($1)',
      [targetIds],
    );
    const byId = new Map(targets.map((t) => [t.user_id, t]));
    const friendsQ = await query('SELECT user_a, user_b FROM friendships WHERE user_a = ANY($1) OR user_b = ANY($1)', [[...targetIds, me]]);
    const friends = new Set();
    for (const f of friendsQ.rows) friends.add(`${f.user_a}|${f.user_b}`);
    const isFriend = (a, b) => friends.has(`${a < b ? a : b}|${a < b ? b : a}`);
    for (const t of targetIds) {
      const p = byId.get(t);
      if (!p || p.is_banned) return res.status(404).json({ message: 'One of those users is unavailable.' });
      if (p.who_can_call === 'nobody') return res.status(403).json({ message: 'That user is not accepting calls.' });
      if (p.who_can_call === 'friends' && !isFriend(me, t)) {
        return res.status(403).json({ message: 'Only friends can call this user.' });
      }
    }
    // Respect blocks in either direction.
    const blockedQ = await query(
      'SELECT blocker_id, blocked_id FROM blocks WHERE (blocker_id = $1 AND blocked_id = ANY($2)) OR (blocked_id = $1 AND blocker_id = ANY($2))',
      [me, targetIds],
    );
    if (blockedQ.rowCount) return res.status(403).json({ message: "You can't call this user." });

    const id = rid('call_');
    const roomCode = crypto.randomBytes(4).toString('hex');
    await query(
      "INSERT INTO calls (id, room_code, kind, is_group, created_by, status) VALUES ($1, $2, $3, $4, $5, 'ringing')",
      [id, roomCode, kind, targetIds.length > 1, me],
    );
    const values = [[me, 'answered'], ...targetIds.map((t) => [t, 'ringing'])];
    for (const [uid, outcome] of values) {
      await query('INSERT INTO call_participants (call_id, user_id, outcome) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, uid, outcome]);
    }
    sendCallPush(targetIds).catch(() => {});
    res.status(201).json({ id, roomCode, kind, isGroup: targetIds.length > 1 });
  } catch (err) { next(err); }
});

/** GET /calls/:id — detail + participant outcomes. */
router.get('/calls/:id', requireUser, async (req, res, next) => {
  try {
    const call = await callFor(req.params.id, req.user.id);
    if (!call) return res.status(404).json({ message: 'Call not found.' });
    const ps = await participantOutcomes(call.id);
    res.json({
      id: call.id, kind: call.kind, isGroup: Boolean(call.is_group), status: call.status,
      roomCode: call.room_code, createdBy: call.created_by,
      startedAt: asIso(call.started_at), answeredAt: call.answered_at ? asIso(call.answered_at) : null,
      endedAt: call.ended_at ? asIso(call.ended_at) : null,
      participants: ps.map((p) => ({
        userId: p.user_id, outcome: p.outcome, username: p.username, displayName: p.display_name, avatarColor: p.avatar_color,
      })),
    });
  } catch (err) { next(err); }
});

/** POST /calls/:id/answer — mark me answered and flip the call to active. */
router.post('/calls/:id/answer', requireUser, async (req, res, next) => {
  try {
    const call = await callFor(req.params.id, req.user.id);
    if (!call) return res.status(404).json({ message: 'Call not found.' });
    if (call.status === 'ended') return res.status(410).json({ message: 'This call already ended.' });
    await query(
      "UPDATE call_participants SET outcome = 'answered' WHERE call_id = $1 AND user_id = $2 AND outcome = 'ringing'",
      [call.id, req.user.id],
    );
    await query(
      "UPDATE calls SET status = 'active', answered_at = coalesce(answered_at, now()) WHERE id = $1",
      [call.id],
    );
    res.json({ ok: true, status: 'active' });
  } catch (err) { next(err); }
});

/** POST /calls/:id/decline — decline my ring. If nobody answered anywhere, end it. */
router.post('/calls/:id/decline', requireUser, async (req, res, next) => {
  try {
    const call = await callFor(req.params.id, req.user.id);
    if (!call) return res.status(404).json({ message: 'Call not found.' });
    await query(
      "UPDATE call_participants SET outcome = 'declined', left_at = coalesce(left_at, now()) WHERE call_id = $1 AND user_id = $2 AND outcome = 'ringing'",
      [call.id, req.user.id],
    );
    const ps = await participantOutcomes(call.id);
    const nonCreator = ps.filter((p) => p.user_id !== call.created_by);
    const anyoneLive = nonCreator.some((p) => p.outcome === 'answered' || p.outcome === 'ringing');
    if (!anyoneLive) {
      await query(
        "UPDATE call_participants SET outcome = 'missed', left_at = coalesce(left_at, now()) WHERE call_id = $1 AND outcome = 'ringing'",
        [call.id],
      );
      await query(
        "UPDATE calls SET status = 'ended', ended_at = coalesce(ended_at, now()) WHERE id = $1",
        [call.id],
      );
      return res.json({ ok: true, status: 'ended' });
    }
    res.json({ ok: true, status: 'active' });
  } catch (err) { next(err); }
});

/** POST /calls/:id/leave — leave/end for me; ends the call when nobody remains active. */
router.post('/calls/:id/leave', requireUser, async (req, res, next) => {
  try {
    const call = await callFor(req.params.id, req.user.id);
    if (!call) return res.status(404).json({ message: 'Call not found.' });
    await query(
      "UPDATE call_participants SET outcome = CASE WHEN outcome = 'ringing' THEN 'missed' ELSE 'left' END, left_at = coalesce(left_at, now()) WHERE call_id = $1 AND user_id = $2",
      [call.id, req.user.id],
    );
    const stillIn = await query(
      "SELECT count(*)::int AS n FROM call_participants WHERE call_id = $1 AND outcome = 'answered' AND left_at IS NULL AND user_id <> $2",
      [call.id, call.created_by],
    );
    if (stillIn.rows[0].n === 0) {
      await query(
        "UPDATE call_participants SET outcome = 'missed', left_at = coalesce(left_at, now()) WHERE call_id = $1 AND outcome = 'ringing'",
        [call.id],
      );
      await query(
        "UPDATE calls SET status = 'ended', ended_at = coalesce(ended_at, now()) WHERE id = $1",
        [call.id],
      );
      return res.json({ ok: true, status: 'ended' });
    }
    res.json({ ok: true, status: 'active' });
  } catch (err) { next(err); }
});

/* ======================= WebRTC signaling relay ======================= */

/** POST /rtc/:room/peers — announce presence in a room (join). */
router.post('/rtc/:room/peers', requireUser, async (req, res, next) => {
  try {
    const room = String(req.params.room).slice(0, 80);
    const name = String(req.body?.name ?? '').slice(0, 64);
    const peerId = String(req.body?.peerId ?? rid('peer_')).slice(0, 64);
    await query(
      `INSERT INTO webrtc_peers (room, peer_id, name, last_seen) VALUES ($1, $2, $3, now())
       ON CONFLICT (room, peer_id) DO UPDATE SET last_seen = now(), name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE webrtc_peers.name END`,
      [room, peerId, name],
    );
    res.json({ peerId });
  } catch (err) { next(err); }
});

/** GET /rtc/:room/peers — list live peers (seen in the last 30s). */
router.get('/rtc/:room/peers', requireUser, async (req, res, next) => {
  try {
    const room = String(req.params.room).slice(0, 80);
    const { rows } = await query(
      "SELECT peer_id, name, last_seen FROM webrtc_peers WHERE room = $1 AND last_seen > now() - interval '30 seconds' ORDER BY last_seen ASC",
      [room],
    );
    res.json(rows.map((r) => ({ peerId: r.peer_id, name: r.name, lastSeen: asIso(r.last_seen) })));
  } catch (err) { next(err); }
});

/** DELETE /rtc/:room/peers/:peerId — leave a room explicitly. */
router.delete('/rtc/:room/peers/:peerId', requireUser, async (req, res, next) => {
  try {
    const room = String(req.params.room).slice(0, 80);
    await query('DELETE FROM webrtc_peers WHERE room = $1 AND peer_id = $2', [room, String(req.params.peerId).slice(0, 64)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** POST /rtc/:room/signals — send SDP/ICE to one peer ("to") or everyone (omit "to"). */
router.post('/rtc/:room/signals', requireUser, async (req, res, next) => {
  try {
    const room = String(req.params.room).slice(0, 80);
    const from = String(req.body?.from ?? '').slice(0, 64);
    const to = req.body?.to ? String(req.body.to).slice(0, 64) : null;
    const kind = String(req.body?.kind ?? '').slice(0, 32);
    if (!from || !kind) return res.status(400).json({ message: 'from and kind are required.' });
    const payload = typeof req.body?.payload === 'object' && req.body.payload !== null ? req.body.payload : {};
    if (JSON.stringify(payload).length > 32_000) return res.status(413).json({ message: 'Signal too large.' });
    const peers = await query('SELECT peer_id FROM webrtc_peers WHERE room = $1', [room]);
    const known = new Set(peers.rows.map((r) => r.peer_id));
    const targets = to ? [to] : [...known].filter((p) => p !== from);
    if (targets.length === 0) return res.json({ sent: 0 });
    let sent = 0;
    for (const t of targets) {
      await query(
        'INSERT INTO webrtc_signals (room, to_peer, from_peer, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [room, t, from, kind, JSON.stringify(payload)],
      );
      sent += 1;
    }
    res.json({ sent });
  } catch (err) { next(err); }
});

/** GET /rtc/:room/signals?for=<peerId>&after=<id> — poll my inbox, then expire old rows. */
router.get('/rtc/:room/signals', requireUser, async (req, res, next) => {
  try {
    const room = String(req.params.room).slice(0, 80);
    const forPeer = String(req.query.for ?? '').slice(0, 64);
    const after = Number(req.query.after ?? 0) || 0;
    if (!forPeer) return res.status(400).json({ message: 'for is required.' });
    const { rows } = await query(
      'SELECT id, from_peer, kind, payload, created_at FROM webrtc_signals WHERE room = $1 AND to_peer = $2 AND id > $3 ORDER BY id ASC LIMIT 100',
      [room, forPeer, after],
    );
    if (rows.length) {
      await query('DELETE FROM webrtc_signals WHERE room = $1 AND to_peer = $2 AND id <= $3', [room, forPeer, rows[rows.length - 1].id]);
      // Also prune ancient signals so the table stays small without a cron.
      await query("DELETE FROM webrtc_signals WHERE created_at < now() - interval '1 hour'");
    }
    res.json(rows.map((r) => ({ id: Number(r.id), from: r.from_peer, kind: r.kind, payload: r.payload, createdAt: asIso(r.created_at) })));
  } catch (err) { next(err); }
});

export default router;
