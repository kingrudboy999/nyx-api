/**
 * NYX platform restore — server-side features that had schema but no API:
 * 2FA (TOTP), public broadcast channels, invite-link joins, KAI threads + public
 * shares, preference objects (sound/notif/theme), login history, mark codes,
 * feed hides, watch parties, Studio renders (Runway-gated), push registration
 * + empty-payload web pushes for call rings, and 6-digit email/phone OTPs.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { requireUser } from '../auth.js';

const router = Router();
const PAGE = 20;
const asIso = (v) => (v instanceof Date ? v.toISOString() : String(v));
const rid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

/* ============================== 2FA (RFC 6238) ============================== */
const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secret, timeMs = Date.now()) {
  const counter = Math.floor(timeMs / 1000 / TOTP_PERIOD);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0); buf.writeUInt32BE(counter, 4);
  const hash = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const bin = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}
export function verifyTotp(secret, code, window = 1) {
  const trimmed = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(trimmed)) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    if (totpAt(secret, now + i * TOTP_PERIOD * 1000) === trimmed) return true;
  }
  return false;
}
const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));
const generateBackupCodes = (n = 8) => Array.from({ length: n }, () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = ''; for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
});
const hashBackupCode = (code) => sha256(String(code).trim().toUpperCase());
const otpauthUrl = (secret, account) =>
  `otpauth://totp/${encodeURIComponent(`NYX:${account}`)}?secret=${secret}&issuer=NYX&period=${TOTP_PERIOD}&digits=${TOTP_DIGITS}`;

async function getTotpProfile(userId) {
  const { rows } = await query(
    'SELECT user_id, username, totp_secret, totp_backup_hashes, totp_enabled, totp_pending FROM profiles WHERE user_id = $1',
    [userId],
  );
  return rows[0] ?? null;
}
async function markTwofaOk(userId) {
  await query(
    `INSERT INTO twofa_ok (user_id, session_ok_until) VALUES ($1, now() + interval '12 hours')
     ON CONFLICT (user_id) DO UPDATE SET session_ok_until = excluded.session_ok_until`,
    [userId],
  );
}

router.get('/2fa/status', requireUser, async (req, res, next) => {
  try {
    const p = await getTotpProfile(req.user.id);
    if (!p?.totp_enabled) return res.json({ enabled: false, required: false });
    const { rows } = await query('SELECT session_ok_until FROM twofa_ok WHERE user_id = $1', [req.user.id]);
    const until = rows[0]?.session_ok_until ? new Date(rows[0].session_ok_until).getTime() : 0;
    res.json({ enabled: true, required: until < Date.now() });
  } catch (err) { next(err); }
});

router.post('/2fa/begin', requireUser, async (req, res, next) => {
  try {
    const p = await getTotpProfile(req.user.id);
    if (!p) return res.status(404).json({ message: 'Profile not found.' });
    const secret = generateTotpSecret();
    await query(
      'UPDATE profiles SET totp_secret = $2, totp_pending = true, totp_enabled = false, updated_at = now() WHERE user_id = $1',
      [req.user.id, secret],
    );
    res.json({ secret, url: otpauthUrl(secret, p.username) });
  } catch (err) { next(err); }
});

router.post('/2fa/confirm', requireUser, async (req, res, next) => {
  try {
    const p = await getTotpProfile(req.user.id);
    if (!p?.totp_secret) return res.status(400).json({ message: 'Start 2FA setup first.' });
    if (!verifyTotp(p.totp_secret, req.body?.code)) return res.status(400).json({ message: 'That code is not valid.' });
    const codes = generateBackupCodes();
    await query(
      'UPDATE profiles SET totp_enabled = true, totp_pending = false, totp_backup_hashes = $2, updated_at = now() WHERE user_id = $1',
      [req.user.id, JSON.stringify(codes.map(hashBackupCode))],
    );
    await markTwofaOk(req.user.id);
    res.json({ backupCodes: codes });
  } catch (err) { next(err); }
});

router.post('/2fa/disable', requireUser, async (req, res, next) => {
  try {
    const p = await getTotpProfile(req.user.id);
    if (!p?.totp_secret) return res.json({ ok: true });
    if (!verifyTotp(p.totp_secret, req.body?.code)) {
      const backup = String(req.body?.code ?? '').trim().toUpperCase();
      let ok = false;
      try {
        const hashes = JSON.parse(p.totp_backup_hashes ?? '[]');
        if (hashes.includes(hashBackupCode(backup))) ok = true;
      } catch { /* ignore */ }
      if (!ok) return res.status(400).json({ message: 'That code is not valid.' });
    }
    await query(
      'UPDATE profiles SET totp_enabled = false, totp_secret = NULL, totp_backup_hashes = NULL, totp_pending = false, updated_at = now() WHERE user_id = $1',
      [req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/2fa/verify', requireUser, async (req, res, next) => {
  try {
    const p = await getTotpProfile(req.user.id);
    if (!p?.totp_enabled || !p.totp_secret) return res.json({ ok: true });
    let ok = verifyTotp(p.totp_secret, req.body?.code);
    if (!ok) {
      try {
        const hashes = JSON.parse(p.totp_backup_hashes ?? '[]');
        const incoming = hashBackupCode(String(req.body?.code ?? ''));
        const idx = hashes.indexOf(incoming);
        if (idx >= 0) {
          hashes.splice(idx, 1);
          await query('UPDATE profiles SET totp_backup_hashes = $2 WHERE user_id = $1', [req.user.id, JSON.stringify(hashes)]);
          ok = true;
        }
      } catch { /* ignore */ }
    }
    if (!ok) return res.status(400).json({ message: 'That code is not valid.' });
    await markTwofaOk(req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ======================= Public broadcast channels ========================= */

router.get('/channels/:username', requireUser, async (req, res, next) => {
  try {
    const uname = String(req.params.username ?? '').trim().toLowerCase().replace(/^@/, '').slice(0, 40);
    const { rows } = await query(
      'SELECT id, title, image_url, description, username_lc FROM conversations WHERE username_lc = $1 AND is_broadcast = true LIMIT 1',
      [uname],
    );
    if (!rows[0]) return res.status(404).json({ message: 'Channel not found.' });
    const ch = rows[0];
    const subs = await query(
      'SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1 AND banned_at IS NULL',
      [ch.id],
    );
    const mine = await query(
      'SELECT banned_at, role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [ch.id, req.user.id],
    );
    const mineRow = mine.rows[0];
    res.json({
      id: ch.id, title: ch.title ?? 'Channel', imageUrl: ch.image_url,
      description: ch.description, username: ch.username_lc,
      subscribers: subs.rows[0].n,
      joined: Boolean(mineRow) && !mineRow.banned_at,
      canPost: Boolean(mineRow) && !mineRow.banned_at && ['owner', 'admin'].includes(mineRow.role),
    });
  } catch (err) { next(err); }
});

router.post('/channels/:username/subscribe', requireUser, async (req, res, next) => {
  try {
    const uname = String(req.params.username ?? '').trim().toLowerCase().replace(/^@/, '').slice(0, 40);
    const { rows } = await query(
      `SELECT c.id, m.banned_at AS my_ban
         FROM conversations c
         LEFT JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $2
        WHERE c.username_lc = $1 AND c.is_broadcast = true LIMIT 1`,
      [uname, req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ message: 'Channel not found.' });
    if (rows[0].my_ban) return res.status(403).json({ message: "You can't join this channel." });
    await query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [rows[0].id, req.user.id],
    );
    res.json({ conversationId: rows[0].id });
  } catch (err) { next(err); }
});

/* ============================ Invite-link join ============================= */

router.post('/join', requireUser, async (req, res, next) => {
  try {
    const token = String(req.body?.token ?? '').trim().slice(0, 64);
    if (!token) return res.status(400).json({ message: 'Missing invite token.' });
    const { rows } = await query(
      'SELECT id, conversation_id, expires_at, max_uses, use_count, require_approval, revoked_at FROM group_invite_links WHERE token = $1 LIMIT 1',
      [token],
    );
    const link = rows[0];
    if (!link || link.revoked_at) return res.status(404).json({ message: "This invite link isn't available." });
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return res.status(410).json({ message: 'This invite link expired.' });
    if (link.max_uses != null && Number(link.use_count) >= Number(link.max_uses)) return res.status(410).json({ message: 'This invite link has no uses left.' });
    const banned = await query(
      'SELECT banned_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [link.conversation_id, req.user.id],
    );
    if (banned.rows[0]?.banned_at) return res.status(403).json({ message: "You can't join this group." });
    const already = await query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [link.conversation_id, req.user.id],
    );
    if (already.rowCount) return res.json({ conversationId: link.conversation_id, pending: false });
    if (link.require_approval) {
      await query(
        'INSERT INTO group_join_requests (conversation_id, user_id, link_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [link.conversation_id, req.user.id, link.id],
      );
      return res.json({ conversationId: link.conversation_id, pending: true });
    }
    await query(
      "INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
      [link.conversation_id, req.user.id],
    );
    await query('UPDATE group_invite_links SET use_count = use_count + 1 WHERE id = $1', [link.id]);
    res.json({ conversationId: link.conversation_id, pending: false });
  } catch (err) { next(err); }
});

/* ======================= KAI threads + public shares ======================= */

router.get('/kai/threads', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT id, title, pinned, updated_at FROM kai_threads WHERE user_id = $1 AND archived = false ORDER BY pinned DESC, updated_at DESC LIMIT 50",
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, title: r.title, pinned: Boolean(r.pinned), updatedAt: asIso(r.updated_at) })));
  } catch (err) { next(err); }
});

router.post('/kai/threads', requireUser, async (req, res, next) => {
  try {
    const id = rid();
    const title = String(req.body?.title ?? 'New chat').trim().slice(0, 120) || 'New chat';
    await query('INSERT INTO kai_threads (id, user_id, title) VALUES ($1, $2, $3)', [id, req.user.id, title]);
    res.status(201).json({ id, title });
  } catch (err) { next(err); }
});

router.get('/kai/threads/:id', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, title, share_id, updated_at FROM kai_threads WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Thread not found.' });
    const msgs = await query(
      'SELECT role, content, created_at FROM kai_messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT 200',
      [req.params.id],
    );
    res.json({
      id: rows[0].id, title: rows[0].title, shareId: rows[0].share_id, updatedAt: asIso(rows[0].updated_at),
      messages: msgs.rows.map((m) => ({ role: m.role, content: m.content, createdAt: asIso(m.created_at) })),
    });
  } catch (err) { next(err); }
});

router.delete('/kai/threads/:id', requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM kai_threads WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ message: 'Thread not found.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/kai/threads/:id/share', requireUser, async (req, res, next) => {
  try {
    const shareId = `os_${crypto.randomBytes(9).toString('base64url')}`;
    const { rowCount } = await query(
      'UPDATE kai_threads SET share_id = $3, updated_at = now() WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id, shareId],
    );
    if (!rowCount) return res.status(404).json({ message: 'Thread not found.' });
    res.json({ shareId });
  } catch (err) { next(err); }
});

/** Public read-only view of a shared thread (no auth — like the old /s/:shareId). */
router.get('/kai/shared/:shareId', async (req, res, next) => {
  try {
    const shareId = String(req.params.shareId ?? '').slice(0, 64);
    const { rows } = await query('SELECT id, title, updated_at FROM kai_threads WHERE share_id = $1', [shareId]);
    if (!rows[0]) return res.status(404).json({ message: 'This shared chat is no longer available.' });
    const msgs = await query(
      'SELECT role, content, created_at FROM kai_messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT 200',
      [rows[0].id],
    );
    res.json({
      title: rows[0].title, updatedAt: asIso(rows[0].updated_at),
      messages: msgs.rows.map((m) => ({ role: m.role, content: m.content, createdAt: asIso(m.created_at) })),
    });
  } catch (err) { next(err); }
});

async function kaiContext(userId) {
  const [posts, views, coinsIn, followers, unread, interests] = await Promise.all([
    query('SELECT count(*) AS n FROM posts WHERE author_id = $1 AND created_at > now() - interval \'7 days\'', [userId]),
    query('SELECT coalesce(sum(coalesce(view_count, 0)), 0) AS n FROM posts WHERE author_id = $1 AND created_at > now() - interval \'7 days\'', [userId]),
    query("SELECT coalesce(sum(amount), 0) AS n FROM coin_ledger WHERE user_id = $1 AND direction = 'in' AND created_at > now() - interval '7 days'", [userId]),
    query("SELECT count(*) AS n FROM follows WHERE following_id = $1", [userId]),
    query('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND is_read = false', [userId]),
    query('SELECT tag FROM user_interests WHERE user_id = $1 LIMIT 8', [userId]),
  ]);
  return {
    posts: Number(posts.rows[0].n), views: Number(views.rows[0].n), coinsIn: Number(coinsIn.rows[0].n),
    followers: Number(followers.rows[0].n), unread: Number(unread.rows[0].n),
    interests: interests.rows.map((r) => r.tag),
  };
}
async function callProvider(system, messages) {
  if (process.env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.NYXAI_MODEL ?? 'claude-3-5-haiku-20241022', max_tokens: 700, system, messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    return data?.content?.find((b) => b.type === 'text')?.text ?? '';
  }
  if (process.env.OPENAI_API_KEY) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.NYXAI_MODEL ?? 'gpt-4o-mini', max_tokens: 700, messages: [{ role: 'system', content: system }, ...messages] }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  }
  return null;
}

/** Chat inside a persisted thread (creates the thread if needed). */
router.post('/kai/threads/:id/chat', requireUser, async (req, res, next) => {
  try {
    const text = String(req.body?.message ?? '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ message: 'Say something first.' });
    let { rows } = await query('SELECT id, title FROM kai_threads WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) {
      return res.status(404).json({ message: 'Thread not found.' });
    }
    const ctx = await kaiContext(req.user.id);
    const system = [
      'You are NYXAI, the assistant inside the NYX night-culture social network.',
      'Be concise (under 120 words), warm, and concrete. Use the user context when relevant.',
      `User context: ${ctx.posts} posts in the last 7 days, ${ctx.views} post views, +${ctx.coinsIn} coins earned, +${ctx.followers} followers, ${ctx.unread} unread notifications, interests: ${ctx.interests.join(', ') || 'not set'}.`,
    ].join(' ');
    const history = await query(
      'SELECT role, content FROM kai_messages WHERE thread_id = $1 AND role IN (\'user\', \'assistant\') ORDER BY created_at DESC LIMIT 10',
      [req.params.id],
    );
    const messages = [
      ...history.rows.reverse().map((m) => ({ role: m.role, content: String(m.content).slice(0, 1000) })),
      { role: 'user', content: text },
    ];
    let reply = await callProvider(system, messages).catch(() => null);
    if (reply == null) {
      reply = `Here's your week on NYX: you published ${ctx.posts} post${ctx.posts === 1 ? '' : 's'}, pulled in ${ctx.views} views, earned ${ctx.coinsIn} Coins and gained ${ctx.followers} follower${ctx.followers === 1 ? '' : 's'}. You have ${ctx.unread} unread notification${ctx.unread === 1 ? '' : 's'}. For free-form answers, an AI provider key (ANTHROPIC_API_KEY or OPENAI_API_KEY) needs to be set on the backend.`;
    }
    if (rows[0].title === 'New chat') {
      const title = text.length > 42 ? `${text.slice(0, 42)}…` : text;
      await query('UPDATE kai_threads SET title = $3 WHERE id = $1 AND user_id = $2', [rows[0].id, req.user.id, title]);
      rows[0].title = title;
    }
    await query("INSERT INTO kai_messages (id, thread_id, role, content, created_at) VALUES ($1, $2, 'user', $3, now())", [rid(), req.params.id, text]);
    await query("INSERT INTO kai_messages (id, thread_id, role, content, created_at) VALUES ($1, $2, 'assistant', $3, now())", [rid(), req.params.id, reply]);
    await query('UPDATE kai_threads SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ reply, threadId: req.params.id, title: rows[0].title });
  } catch (err) { next(err); }
});

/* ===================== Sound / notification / theme prefs ================== */
const SOUND_DEFAULTS = { messages: true, typing: true, calls: true, notifications: true, vibration: true };
const NOTIF_DEFAULTS = {
  messages: true, friends: true, followers: true, likes: true, comments: true, live: true,
  stories: true, streaks: true, messagePopup: true, messageReminders: true, mentions: true,
};
const THEMES = new Set(['light', 'dark', 'system']);
const mergeBool = (defaults, incoming) => {
  const out = { ...defaults };
  if (incoming && typeof incoming === 'object') {
    for (const k of Object.keys(defaults)) if (typeof incoming[k] === 'boolean') out[k] = incoming[k];
  }
  return out;
};

router.get('/settings/prefs', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT sound_prefs, notif_prefs, theme FROM profiles WHERE user_id = $1', [req.user.id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ message: 'Profile not found.' });
    res.json({
      soundPrefs: mergeBool(SOUND_DEFAULTS, p.sound_prefs),
      notifPrefs: mergeBool(NOTIF_DEFAULTS, p.notif_prefs),
      theme: THEMES.has(p.theme) ? p.theme : 'system',
    });
  } catch (err) { next(err); }
});

router.put('/settings/prefs', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT sound_prefs, notif_prefs, theme FROM profiles WHERE user_id = $1', [req.user.id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ message: 'Profile not found.' });
    const sound = mergeBool(SOUND_DEFAULTS, p.sound_prefs);
    const notif = mergeBool(NOTIF_DEFAULTS, p.notif_prefs);
    let theme = THEMES.has(p.theme) ? p.theme : 'system';
    const b = req.body ?? {};
    if (b.soundPrefs && typeof b.soundPrefs === 'object') Object.assign(sound, mergeBool(SOUND_DEFAULTS, b.soundPrefs));
    if (b.notifPrefs && typeof b.notifPrefs === 'object') Object.assign(notif, mergeBool(NOTIF_DEFAULTS, b.notifPrefs));
    if (typeof b.theme === 'string' && THEMES.has(b.theme)) theme = b.theme;
    await query('UPDATE profiles SET sound_prefs = $2::jsonb, notif_prefs = $3::jsonb, theme = $4, updated_at = now() WHERE user_id = $1', [req.user.id, JSON.stringify(sound), JSON.stringify(notif), theme]);
    res.json({ soundPrefs: sound, notifPrefs: notif, theme });
  } catch (err) { next(err); }
});

/* =============================== Login history ============================= */
router.get('/security/login-history', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, created_at, user_agent FROM login_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, createdAt: asIso(r.created_at), userAgent: r.user_agent ?? null, kind: null })));
  } catch (err) { next(err); }
});

/* ================================ Mark codes =============================== */
const MARK_CODES = new Map([['9999', 'arc'], ['0916', 'founder'], ['0915', 'org']]);
const MARK_LABEL = { arc: 'ARC Admin', founder: 'Nyx founder', org: 'Official organization' };
const roleForKind = (k) => (k === 'arc' || k === 'founder' ? 'super_admin' : 'admin');

router.post('/marks/redeem', requireUser, async (req, res, next) => {
  try {
    const code = String(req.body?.code ?? '').replace(/\s+/g, '');
    const kind = MARK_CODES.get(code);
    if (!kind) return res.status(400).json({ message: "That code didn't work." });
    const meQ = await query('SELECT user_id, verify_kind, is_arc, role, is_banned FROM profiles WHERE user_id = $1', [req.user.id]);
    const me = meQ.rows[0];
    if (!me) return res.status(404).json({ message: 'Profile not found.' });
    if (me.is_banned) return res.status(403).json({ message: 'This account cannot redeem marks.' });
    const blocked = await query('SELECT 1 FROM mark_blocks WHERE user_id = $1 AND kind = $2', [req.user.id, kind]);
    if (blocked.rowCount) return res.status(400).json({ message: "That code didn't work." });

    const note = (action, badge, prevRole, newRole) => query(
      'INSERT INTO admin_audit (id, actor_id, action, target_id, detail) VALUES ($1, $2, $3, $4, $5)',
      [rid(), req.user.id, action, req.user.id, badge],
    ).catch(() => {});

    if (kind === 'arc') {
      if (me.is_arc) {
        return res.json({ ok: true, verifyKind: me.verify_kind, isArc: true, label: MARK_LABEL.arc });
      }
      let claimed = null;
      for (const seat of [1, 2, 3]) {
        try {
          await query('INSERT INTO mark_seats (kind, seat, user_id) VALUES ($1, $2, $3)', ['arc', seat, req.user.id]);
          claimed = seat; break;
        } catch { /* seat taken */ }
      }
      if (claimed == null) {
        const existing = await query("SELECT seat FROM mark_seats WHERE kind = 'arc' AND user_id = $1", [req.user.id]);
        if (!existing.rows[0]) return res.status(400).json({ message: "That code didn't work." });
      }
      await query(
        `UPDATE profiles SET is_arc = true, is_verified = true, role = 'super_admin', updated_at = now() WHERE user_id = $1`,
        [req.user.id],
      );
      await query(
        `INSERT INTO badge_events (id, user_id, actor_id, action, badge, previous_kind, previous_role, new_kind, new_role, reason)
         VALUES ($1, $2, $3, 'grant', 'arc', $4, $5, $4, 'super_admin', 'Authorized ARC seat')`,
        [rid(), req.user.id, req.user.id, me.verify_kind ?? 'none', me.role ?? 'user'],
      ).catch(() => {});
      await note('mark_arc', MARK_LABEL.arc, me.role, 'super_admin');
      return res.json({ ok: true, verifyKind: me.verify_kind, isArc: true, label: MARK_LABEL.arc });
    }

    if (kind === 'founder') {
      await query(
        `INSERT INTO mark_redemptions (kind, user_id) VALUES ('founder', $1)
         ON CONFLICT (kind) DO NOTHING`,
        [req.user.id],
      );
      const existing = await query("SELECT user_id FROM mark_redemptions WHERE kind = 'founder' LIMIT 1");
      if (!existing.rows[0] || existing.rows[0].user_id !== req.user.id) {
        return res.status(400).json({ message: "That code didn't work." });
      }
    }
    const effectiveKind = ['org', 'founder', 'developer'].includes(me.verify_kind) ? me.verify_kind : kind;
    if (me.verify_kind === kind) {
      return res.json({ ok: true, verifyKind: kind, isArc: Boolean(me.is_arc), label: MARK_LABEL[effectiveKind] });
    }
    const role = me.is_arc ? 'super_admin' : roleForKind(kind);
    await query(
      'UPDATE profiles SET verify_kind = $2, is_verified = true, role = $3, updated_at = now() WHERE user_id = $1',
      [req.user.id, kind, role],
    );
    await query(
      `INSERT INTO badge_events (id, user_id, actor_id, action, badge, previous_kind, previous_role, new_kind, new_role, reason)
       VALUES ($1, $2, $3, 'grant', $4, $5, $6, $4, $7, 'Mark code redeemed')`,
      [rid(), req.user.id, req.user.id, kind, me.verify_kind ?? 'none', me.role ?? 'user', role],
    ).catch(() => {});
    await note(`mark_${kind}`, MARK_LABEL[kind], me.role, role);
    res.json({ ok: true, verifyKind: kind, isArc: Boolean(me.is_arc), label: MARK_LABEL[kind] });
  } catch (err) { next(err); }
});

/* ============================ Feed hide / mute ============================= */
router.post('/feed/hide', requireUser, async (req, res, next) => {
  try {
    const kind = ['post', 'author', 'video'].includes(String(req.body?.targetKind)) ? String(req.body.targetKind) : 'post';
    const id = String(req.body?.targetId ?? '').slice(0, 80);
    const reason = ['not_interested', 'mute', 'hide'].includes(String(req.body?.reason)) ? String(req.body.reason) : 'not_interested';
    if (!id) return res.status(400).json({ message: 'Nothing to hide.' });
    await query(
      `INSERT INTO feed_hides (user_id, target_kind, target_id, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, target_kind, target_id) DO UPDATE SET reason = excluded.reason`,
      [req.user.id, kind, id, reason],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/feed/hide', requireUser, async (req, res, next) => {
  try {
    const kind = ['post', 'author', 'video'].includes(String(req.query.targetKind)) ? String(req.query.targetKind) : 'post';
    const id = String(req.query.targetId ?? '').slice(0, 80);
    if (!id) return res.status(400).json({ message: 'Nothing to unhide.' });
    await query('DELETE FROM feed_hides WHERE user_id = $1 AND target_kind = $2 AND target_id = $3', [req.user.id, kind, id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/feed/topic-mute', requireUser, async (req, res, next) => {
  try {
    const tag = String(req.body?.tag ?? '').trim().toLowerCase().replace(/^#/, '').slice(0, 64);
    const enabled = !['false', '0', 'off'].includes(String(req.body?.enabled ?? 'true').toLowerCase());
    if (!tag) return res.status(400).json({ message: 'Missing tag.' });
    if (!enabled) {
      await query('DELETE FROM feed_topic_mutes WHERE user_id = $1 AND tag = $2', [req.user.id, tag]);
      return res.json({ ok: true, muted: false });
    }
    await query('INSERT INTO feed_topic_mutes (user_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, tag]);
    res.json({ ok: true, muted: true });
  } catch (err) { next(err); }
});

/* =============================== Watch parties ============================= */
router.post('/watch-parties', requireUser, async (req, res, next) => {
  try {
    const postId = String(req.body?.videoId ?? req.body?.postId ?? '').slice(0, 80);
    const conversationId = req.body?.conversationId ? String(req.body.conversationId).slice(0, 80) : null;
    if (!postId) return res.status(400).json({ message: 'Pick a video first.' });
    const exists = await query('SELECT 1 FROM posts WHERE id = $1 AND is_removed = false', [postId]);
    if (!exists.rowCount) return res.status(404).json({ message: 'Video not found.' });
    const id = `wp_${crypto.randomBytes(8).toString('base64url')}`;
    await query(
      'INSERT INTO watch_parties (id, host_id, video_id, conversation_id, playing) VALUES ($1, $2, $3, $4, false)',
      [id, req.user.id, postId, conversationId],
    );
    await query('INSERT INTO watch_party_members (party_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, req.user.id]);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

async function watchPartyState(partyId, userId, { positionMs, playing } = {}) {
  const party = await query('SELECT host_id, video_id, position_ms, playing, updated_at FROM watch_parties WHERE id = $1 LIMIT 1', [partyId]);
  if (!party.rows[0]) return null;
  await query(
    `INSERT INTO watch_party_members (party_id, user_id, last_seen_at) VALUES ($1, $2, now())
     ON CONFLICT (party_id, user_id) DO UPDATE SET last_seen_at = now()`,
    [partyId, userId],
  );
  if (party.rows[0].host_id === userId && (positionMs != null || playing != null)) {
    await query(
      'UPDATE watch_parties SET position_ms = $2, playing = $3, updated_at = now() WHERE id = $1',
      [partyId, Math.max(0, Math.floor(positionMs ?? party.rows[0].position_ms)), playing ?? party.rows[0].playing],
    );
  }
  const fresh = await query('SELECT host_id, video_id, position_ms, playing, updated_at FROM watch_parties WHERE id = $1', [partyId]);
  const viewers = await query(
    "SELECT count(*)::int AS n FROM watch_party_members WHERE party_id = $1 AND last_seen_at > now() - interval '30 seconds'",
    [partyId],
  );
  const f = fresh.rows[0];
  return {
    positionMs: Number(f.position_ms), playing: Boolean(f.playing), videoId: f.video_id,
    hostId: f.host_id, viewers: viewers.rows[0].n, isHost: f.host_id === userId, updatedAt: asIso(f.updated_at),
  };
}

router.get('/watch-parties/:id', requireUser, async (req, res, next) => {
  try {
    const state = await watchPartyState(req.params.id, req.user.id);
    if (!state) return res.status(404).json({ message: 'Party not found.' });
    res.json(state);
  } catch (err) { next(err); }
});

router.post('/watch-parties/:id/sync', requireUser, async (req, res, next) => {
  try {
    const state = await watchPartyState(req.params.id, req.user.id, {
      positionMs: req.body?.positionMs != null ? Number(req.body.positionMs) : undefined,
      playing: typeof req.body?.playing === 'boolean' ? req.body.playing : undefined,
    });
    if (!state) return res.status(404).json({ message: 'Party not found.' });
    res.json(state);
  } catch (err) { next(err); }
});

/* ============================== Studio render ============================== */
router.post('/studio/render', requireUser, async (req, res, next) => {
  try {
    const prompt = String(req.body?.prompt ?? '').trim().slice(0, 1000);
    if (!prompt) return res.status(400).json({ message: 'Describe the shot first.' });
    if (!process.env.RUNWAY_API_KEY?.trim()) {
      return res.status(503).json({ message: 'Runway is not configured on this server. Set RUNWAY_API_KEY to enable AI video renders.' });
    }
    const id = rid();
    const model = process.env.RUNWAY_MODEL?.trim() || 'gen4.5';
    await query(
      "INSERT INTO nyx_video_jobs (id, user_id, provider, model, prompt, status) VALUES ($1, $2, 'runway', $3, $4, 'pending')",
      [id, req.user.id, model, prompt],
    );
    const ratio = ['1280:720', '720:1280', '1104:832', '960:960'].includes(String(req.body?.ratio)) ? String(req.body.ratio) : '1280:720';
    const duration = [5, 10].includes(Number(req.body?.duration)) ? Number(req.body.duration) : 5;
    try {
      const resRun = await fetch('https://api.dev.runwayml.com/v1/text_to_video', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RUNWAY_API_KEY.trim()}`, 'Content-Type': 'application/json', 'X-Runway-Version': '2024-11-06' },
        body: JSON.stringify({ model, promptText: prompt, ratio, duration }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await resRun.json().catch(() => ({}));
      if (!resRun.ok || !j?.id) {
        await query("UPDATE nyx_video_jobs SET status = 'failed', error = $2 WHERE id = $1", [id, String(j?.error ?? j?.message ?? `Runway ${resRun.status}`).slice(0, 200)]);
        return res.status(502).json({ message: 'Runway rejected the render. Check the job for details.', id });
      }
      await query("UPDATE nyx_video_jobs SET status = 'running', task_id = $2 WHERE id = $1", [id, String(j.id)]);
      return res.status(201).json({ id, status: 'running' });
    } catch (e) {
      await query("UPDATE nyx_video_jobs SET status = 'failed', error = $2 WHERE id = $1", [id, String(e?.message ?? e).slice(0, 200)]);
      throw e;
    }
  } catch (err) { next(err); }
});

router.post('/studio/render/:id/refresh', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM nyx_video_jobs WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ message: 'Render not found.' });
    if (!job.task_id || !process.env.RUNWAY_API_KEY?.trim()) return res.json(mapJob(job));
    const resTask = await fetch(`https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(job.task_id)}`, {
      headers: { Authorization: `Bearer ${process.env.RUNWAY_API_KEY.trim()}`, 'X-Runway-Version': '2024-11-06' },
      signal: AbortSignal.timeout(20_000),
    });
    const j = await resTask.json().catch(() => ({}));
    const status = String(j?.status ?? '').toUpperCase();
    if (status === 'SUCCEEDED') {
      const url = Array.isArray(j?.output) ? j.output[0] : null;
      await query("UPDATE nyx_video_jobs SET status = 'ready', output_url = $2, completed_at = now() WHERE id = $1", [job.id, url]);
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      await query("UPDATE nyx_video_jobs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1", [job.id, String(j?.failure ?? j?.error ?? 'Render failed').slice(0, 200)]);
    } else if (status === 'RUNNING' || status === 'THROTTLED') {
      await query("UPDATE nyx_video_jobs SET status = 'running' WHERE id = $1", [job.id]);
    }
    const { rows: fresh } = await query('SELECT * FROM nyx_video_jobs WHERE id = $1', [job.id]);
    res.json(mapJob(fresh[0]));
  } catch (err) { next(err); }
});

function mapJob(j) {
  return {
    id: j.id, prompt: j.prompt,
    status: j.status === 'ready' || j.status === 'succeeded' || j.status === 'completed' ? 'ready' : j.status === 'failed' ? 'failed' : 'rendering',
    outputUrl: j.output_url ?? null, error: j.error ?? null, createdAt: asIso(j.created_at),
  };
}

/* ===================== Push registration + call rings ====================== */
router.post('/push/register', requireUser, async (req, res, next) => {
  try {
    const token = String(req.body?.token ?? '').slice(0, 512);
    const platform = ['ios', 'android', 'web'].includes(String(req.body?.platform)) ? String(req.body.platform) : 'android';
    if (!token) return res.status(400).json({ message: 'Missing token.' });
    const id = rid();
    await query(
      `INSERT INTO device_push_tokens (id, user_id, token, platform) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, updated_at = now()`,
      [id, req.user.id, token, platform],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/push/web', requireUser, async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint ?? '').slice(0, 2048);
    const p256dh = String(req.body?.keys?.p256dh ?? req.body?.p256dh ?? '').slice(0, 256);
    const auth = String(req.body?.keys?.auth ?? req.body?.auth ?? '').slice(0, 256);
    if (!endpoint || !endpoint.startsWith('https://')) return res.status(400).json({ message: 'Invalid subscription.' });
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : null;
    await query(
      `INSERT INTO web_push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      [rid(), req.user.id, endpoint, p256dh || '-', auth || '-', ua],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/push/web', requireUser, async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint ?? req.query.endpoint ?? '');
    if (endpoint) await query('DELETE FROM web_push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

function b64urlBytes(s) {
  const pad = '='.repeat((4 - (String(s).length % 4)) % 4);
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** VAPID JWT via ES256 (Node 20+ JWK import). Empty payload = generic push. */
function vapidJwt(endpoint, subject, privateB64url, publicB64url) {
  try {
    const pub = b64urlBytes(publicB64url);
    if (pub.length !== 65 || pub[0] !== 4) return null;
    const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: String(privateB64url) }, format: 'jwk' });
    const aud = new URL(endpoint).origin;
    const header = b64urlJson({ typ: 'JWT', alg: 'ES256' });
    const payload = b64urlJson({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
    const data = `${header}.${payload}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
    return `${data}.${b64url(sig)}`;
  } catch {
    return null;
  }
}

/** Fire-and-forget empty-payload web push (generic ring notification). */
export async function sendCallPush(userIds, payload = { title: 'Incoming call' }) {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !pub || !priv || !Array.isArray(userIds) || userIds.length === 0) return { sent: 0, reason: 'vapid not configured' };
  void payload;
  const { rows } = await query('SELECT endpoint FROM web_push_subscriptions WHERE user_id = ANY($1)', [userIds]);
  let sent = 0;
  for (const row of rows) {
    try {
      const jwt = vapidJwt(row.endpoint, subject, priv, pub);
      if (!jwt) continue;
      const res = await fetch(row.endpoint, {
        method: 'POST',
        headers: { TTL: '60', Urgency: 'high', Authorization: `vapid t=${jwt}, k=${pub}`, 'Content-Length': '0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 201 || res.status === 200 || res.status === 202) sent += 1;
      else if (res.status === 404 || res.status === 410) {
        await query('DELETE FROM web_push_subscriptions WHERE endpoint = $1', [row.endpoint]);
      }
    } catch { /* next subscription */ }
  }
  return { sent };
}

/* ================= Email + phone OTP verification (6-digit) ================= */
const otpHash = (code) => sha256(String(code).trim());
const genOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
async function sendMail(to, subject, text) {
  if (!process.env.SMTP_URL?.trim()) return { ok: false, reason: 'smtp not configured' };
  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport(process.env.SMTP_URL.trim());
  await transporter.sendMail({ from: process.env.SMTP_FROM?.trim() || 'NYX <no-reply@nyx.app>', to, subject, text });
  return { ok: true };
}

router.post('/email/verify/request', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT email FROM "user" WHERE id = $1', [req.user.id]);
    const email = rows[0]?.email;
    if (!email) return res.status(404).json({ message: 'Account not found.' });
    if (!process.env.SMTP_URL?.trim()) {
      return res.status(503).json({ message: 'Email is not configured on this server. Set SMTP_URL to enable verification codes.' });
    }
    const code = genOtp();
    await query(
      "INSERT INTO email_verify_codes (id, user_id, email, code_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')",
      [rid(), req.user.id, email, otpHash(code)],
    );
    await sendMail(email, 'Your NYX verification code', `Your NYX verification code is ${code}. It expires in 10 minutes.`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/email/verify/confirm', requireUser, async (req, res, next) => {
  try {
    const code = String(req.body?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the 6-digit code.' });
    const { rows } = await query(
      "SELECT id, code_hash, attempts FROM email_verify_codes WHERE user_id = $1 AND verified_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [req.user.id],
    );
    const row = rows[0];
    if (!row) return res.status(400).json({ message: 'No active code. Request a new one.' });
    if (row.attempts >= 5) return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
    if (row.code_hash !== otpHash(code)) {
      await query('UPDATE email_verify_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return res.status(400).json({ message: 'That code is not valid.' });
    }
    await query('UPDATE email_verify_codes SET verified_at = now() WHERE id = $1', [row.id]);
    await query('UPDATE "user" SET "emailVerified" = true, "updatedAt" = now() WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

const E164 = /^\+[1-9]\d{6,14}$/;
router.post('/phone/otp/request', requireUser, async (req, res, next) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    if (!E164.test(phone)) return res.status(400).json({ message: 'Enter a full number like +2348012345678.' });
    const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const token = process.env.TWILIO_AUTH_TOKEN?.trim();
    const from = process.env.TWILIO_FROM?.trim();
    if (!sid || !token || !from) {
      return res.status(503).json({ message: 'SMS is not configured on this server. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.' });
    }
    const code = genOtp();
    await query(
      "INSERT INTO phone_otp_codes (id, user_id, phone_e164, code_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')",
      [rid(), req.user.id, phone, otpHash(code)],
    );
    const body = new URLSearchParams({ To: phone, From: from, Body: `Your NYX verification code is ${code}. It expires in 10 minutes.` });
    const resSms = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resSms.ok) {
      const j = await resSms.text().catch(() => '');
      return res.status(502).json({ message: `SMS provider rejected the request. ${j.slice(0, 140)}` });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/phone/otp/confirm', requireUser, async (req, res, next) => {
  try {
    const phone = String(req.body?.phone ?? '').trim();
    const code = String(req.body?.code ?? '').trim();
    if (!E164.test(phone)) return res.status(400).json({ message: 'Enter a full number like +2348012345678.' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the 6-digit code.' });
    const { rows } = await query(
      "SELECT id, code_hash, attempts FROM phone_otp_codes WHERE user_id = $1 AND phone_e164 = $2 AND verified_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
      [req.user.id, phone],
    );
    const row = rows[0];
    if (!row) return res.status(400).json({ message: 'No active code. Request a new one.' });
    if (row.attempts >= 5) return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
    if (row.code_hash !== otpHash(code)) {
      await query('UPDATE phone_otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return res.status(400).json({ message: 'That code is not valid.' });
    }
    await query('UPDATE phone_otp_codes SET verified_at = now() WHERE id = $1', [row.id]);
    await query('UPDATE profiles SET phone_e164 = $2, phone_verified_at = now(), updated_at = now() WHERE user_id = $1', [req.user.id, phone]);
    res.json({ ok: true, phone });
  } catch (err) { next(err); }
});

router.get('/phone', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT phone_e164, phone_verified_at FROM profiles WHERE user_id = $1', [req.user.id]);
    res.json({
      phone: rows[0]?.phone_e164 ?? null,
      verifiedAt: rows[0]?.phone_verified_at ? asIso(rows[0].phone_verified_at) : null,
      configured: Boolean(process.env.TWILIO_ACCOUNT_SID?.trim() && process.env.TWILIO_AUTH_TOKEN?.trim() && process.env.TWILIO_FROM?.trim()),
    });
  } catch (err) { next(err); }
});

/* ================= Password reset OTP (6-digit, SMTP-gated) ================= */
/* Ports the old forgot-password flow: rate limits, attempt cap, TTL, sessions revoked.
   Without SMTP_URL configured the request endpoint refuses with 503 — never faked. */
const RESET_TTL_MIN = 10;
const RESET_MAX_ATTEMPTS = 5;
const resetLimiter = new Map(); // email_lc -> { n, windowStart, lastRequest }
function resetRate(email) {
  const now = Date.now();
  const e = resetLimiter.get(email) ?? { n: 0, windowStart: now, lastRequest: 0 };
  if (now - e.windowStart > 15 * 60_000) { e.n = 0; e.windowStart = now; }
  const perMin = e.lastRequest && now - e.lastRequest < 60_000;
  e.n += 1; e.lastRequest = now;
  resetLimiter.set(email, e);
  if (e.n > 3) return 'Too many reset requests. Try again in 15 minutes.';
  if (perMin) return 'Wait a minute before requesting another code.';
  return null;
}

router.post('/password/forgot-password', async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }
    const limited = resetRate(email);
    if (limited) return res.status(429).json({ message: limited });
    if (!process.env.SMTP_URL?.trim()) {
      return res.status(503).json({ message: 'Password reset mail is not configured on this deployment. Ask the admin to set SMTP_URL.' });
    }
    const { rows } = await query('SELECT id, email FROM "user" WHERE lower(email) = $1 LIMIT 1', [email]);
    const user = rows[0];
    const GENERIC = { ok: true, message: "If an account exists for this email address, we'll send a password reset code." };
    if (!user?.id) return res.json(GENERIC); // do not reveal account existence
    const code = genOtp();
    await query('UPDATE password_reset_otps SET used_at = now() WHERE email_lc = $1 AND used_at IS NULL', [email]);
    await query(
      "INSERT INTO password_reset_otps (id, email_lc, user_id, code_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')",
      [rid(), email, user.id, sha256(code)],
    );
    try {
      await sendMail(user.email, 'Your NYX password reset code',
        `Your NYX password reset code is ${code}. It expires in ${RESET_TTL_MIN} minutes. If you didn't ask for it, you can ignore this email.`);
    } catch (err) {
      return res.status(502).json({ message: 'Could not send the reset email. Check the server mail configuration.' });
    }
    res.json(GENERIC);
  } catch (err) { next(err); }
});

router.post('/password/reset-password', async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 120);
    const code = String(req.body?.code ?? '').replace(/\s/g, '');
    const password = String(req.body?.newPassword ?? req.body?.password ?? '');
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: 'Enter the 6-digit code from the email.' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    const { rows } = await query(
      'SELECT id, user_id, code_hash, attempts, expires_at FROM password_reset_otps WHERE email_lc = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [email],
    );
    const row = rows[0];
    if (!row || !row.user_id) return res.status(400).json({ message: 'That code is not valid.' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await query('UPDATE password_reset_otps SET used_at = now() WHERE id = $1', [row.id]);
      return res.status(400).json({ message: 'That code has expired. Request a new one.' });
    }
    if (row.attempts >= RESET_MAX_ATTEMPTS) {
      await query('UPDATE password_reset_otps SET used_at = now() WHERE id = $1', [row.id]);
      return res.status(429).json({ message: 'Too many attempts. Request a new code.' });
    }
    if (row.code_hash !== sha256(code)) {
      await query('UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return res.status(400).json({ message: 'That code is not valid.' });
    }
    // Hash the new password exactly the way better-auth hashes credential passwords.
    const { auth } = await import('../auth.js');
    const ctx = await auth.$context;
    const hashed = await ctx.password.hash(password);
    await query('UPDATE account SET password = $1 WHERE "userId" = $2 AND "providerId" = $3', [hashed, row.user_id, 'credential']);
    await query('DELETE FROM session WHERE "userId" = $1', [row.user_id]); // force re-login everywhere
    await query('UPDATE password_reset_otps SET used_at = now() WHERE email_lc = $1 AND used_at IS NULL', [email]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
