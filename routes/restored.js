/**
 * Restored feature parity — the second half of the product surface that the
 * earlier port skipped. Everything here is real, Postgres-backed, and
 * requires auth: flashes, highlights, sounds, search, chat extras
 * (react/edit/delete/typing/scheduled/view-once/archive/pin), saved
 * collections, admin sanctions/warnings, ghost map pings, tag follows,
 * profile post lists, boosts, and challenge submissions.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { query, avatarColor } from '../db.js';
import { requireUser } from '../auth.js';

const router = Router();
const rid = () => randomUUID();
const asIso = (v) => (v instanceof Date ? v.toISOString() : String(v));
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
const cleanTag = (s) => String(s ?? '').trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 60);

async function requireAdmin(req, res, next) {
  try {
    const { rows } = await query('SELECT role FROM profiles WHERE user_id = $1', [req.user.id]);
    if (!rows.length || !['admin', 'super_admin'].includes(rows[0].role)) {
      return res.status(403).json({ message: 'Admin only' });
    }
    next();
  } catch (err) { next(err); }
}

const mapMiniPost = (r) => ({
  id: r.id, body: r.body, kind: r.kind, createdAt: asIso(r.created_at),
  author: { username: r.username, displayName: r.display_name, avatarColor: avatarColor(r.author_id), verified: Boolean(r.is_verified) },
  likes: Number(r.likes), comments: Number(r.comments), reposts: Number(r.reposts), views: Number(r.view_count) || 0,
  liked: Boolean(r.liked), bookmarked: Boolean(r.bookmarked),
  media: r.media_kind === 'video' ? 'video' : r.media_kind === 'image' ? 'image' : undefined,
  boosted: Boolean(r.boosted),
});

const MINI_POST_SQL = (where) => `
  SELECT p.id, p.body, p.kind, p.created_at, p.view_count, p.repost_of_id,
         pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified,
         (SELECT count(*) FROM post_likes pl WHERE pl.post_id = p.id) AS likes,
         (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.is_removed = false) AS comments,
         (SELECT count(*) FROM posts r WHERE r.repost_of_id = p.id) AS reposts,
         (p.boosted_until IS NOT NULL AND p.boosted_until > now()) AS boosted,
         EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1) AS liked,
         EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS bookmarked,
         (SELECT kind FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.sort_order, pm.id LIMIT 1) AS media_kind
    FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
   WHERE p.is_removed = false AND ${where}
   ORDER BY created_at DESC LIMIT 40`;

// Mutual-follow (friends) helper SQL uses $1 = my user id.
const FRIENDS_SQL = `SELECT following_id FROM follows WHERE follower_id = $1 INTERSECT SELECT follower_id FROM follows WHERE following_id = $1`;

// ================= FLASHES =================

router.post('/flashes', requireUser, async (req, res, next) => {
  try {
    const mediaUrl = String(req.body?.mediaUrl ?? '');
    const mediaKind = req.body?.mediaKind === 'video' ? 'video' : 'photo';
    if (!mediaUrl || mediaUrl.length > 1_500_000) return res.status(400).json({ message: 'A (reasonably sized) media item is required.' });
    const caption = String(req.body?.caption ?? '').slice(0, 300);
    const filterName = String(req.body?.filterName ?? 'none').slice(0, 40);
    const durationSec = Math.max(1, Math.min(60, Number(req.body?.durationSec) || 5));
    let recipients = Array.isArray(req.body?.recipientIds) ? req.body.recipientIds.map(String).slice(0, 32) : [];
    if (req.body?.recipient === 'friends') {
      const { rows } = await query(FRIENDS_SQL, [req.user.id]);
      recipients = rows.map((r) => r.following_id);
    }
    if (!recipients.length) return res.status(400).json({ message: 'Pick at least one friend.' });
    const id = rid();
    await query(
      'INSERT INTO flashes (id, author_id, media_url, media_kind, caption, filter_name, duration_sec, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [id, req.user.id, mediaUrl, mediaKind, caption, filterName, durationSec],
    );
    for (const to of recipients) {
      await query('INSERT INTO flash_sends (flash_id, recipient_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, to]);
      await query(
        "INSERT INTO notifications (id, user_id, kind, actor_id, entity_id, body) VALUES ($1,$2,'flash',$3,$4,'sent you a Flash')",
        [rid(), to, req.user.id, id],
      );
    }
    res.status(201).json({ id, recipients: recipients.length });
  } catch (err) { next(err); }
});

router.get('/flashes/received', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.id, f.media_url, f.media_kind, f.caption, f.filter_name, f.duration_sec, f.created_at,
              fs.opened_at, pr.user_id AS sender_id, pr.username, pr.display_name, pr.is_verified
         FROM flash_sends fs
         JOIN flashes f ON f.id = fs.flash_id AND f.expires_at > now()
         JOIN profiles pr ON pr.user_id = f.author_id
        WHERE fs.recipient_id = $1
        ORDER BY f.created_at DESC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.id, mediaUrl: r.media_url, mediaKind: r.media_kind, caption: r.caption,
      filterName: r.filter_name, durationSec: r.duration_sec, createdAt: asIso(r.created_at),
      opened: Boolean(r.opened_at),
      sender: { username: r.username, displayName: r.display_name, avatarColor: avatarColor(r.sender_id), verified: Boolean(r.is_verified) },
    })));
  } catch (err) { next(err); }
});

router.get('/flashes/mine', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.id, f.media_url, f.media_kind, f.caption, f.duration_sec, f.created_at,
              (SELECT count(*) FROM flash_sends fs WHERE fs.flash_id = f.id) AS sent,
              (SELECT count(*) FROM flash_sends fs WHERE fs.flash_id = f.id AND fs.opened_at IS NOT NULL) AS opened
         FROM flashes f WHERE f.author_id = $1 AND f.expires_at > now() ORDER BY f.created_at DESC LIMIT 30`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.id, mediaUrl: r.media_url, mediaKind: r.media_kind, caption: r.caption,
      durationSec: r.duration_sec, createdAt: asIso(r.created_at), sent: Number(r.sent), opened: Number(r.opened),
    })));
  } catch (err) { next(err); }
});

router.get('/flashes/:id', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.id, f.media_url, f.media_kind, f.caption, f.filter_name, f.duration_sec, f.created_at, f.author_id,
              pr.username, pr.display_name, pr.is_verified,
              EXISTS (SELECT 1 FROM flash_sends fs WHERE fs.flash_id = f.id AND fs.recipient_id = $2) AS mine_send
         FROM flashes f JOIN profiles pr ON pr.user_id = f.author_id
        WHERE f.id = $1 AND f.expires_at > now()`,
      [req.params.id, req.user.id],
    );
    const r = rows[0];
    if (!r) return res.status(404).json({ message: 'This Flash is gone.' });
    if (r.author_id !== req.user.id && !r.mine_send) return res.status(403).json({ message: 'Not your Flash.' });
    res.json({
      id: r.id, mediaUrl: r.media_url, mediaKind: r.media_kind, caption: r.caption,
      filterName: r.filter_name, durationSec: r.duration_sec, createdAt: asIso(r.created_at),
      sender: { username: r.username, displayName: r.display_name, avatarColor: avatarColor(r.author_id), verified: Boolean(r.is_verified) },
      mine: r.author_id === req.user.id,
    });
  } catch (err) { next(err); }
});

router.post('/flashes/:id/open', requireUser, async (req, res, next) => {
  try {
    await query('UPDATE flash_sends SET opened_at = coalesce(opened_at, now()) WHERE flash_id = $1 AND recipient_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= STORY HIGHLIGHTS =================

const mapHighlight = (r) => ({
  id: r.id, name: r.name, coverUrl: r.cover_url ?? null,
  count: Number(r.items), updatedAt: asIso(r.updated_at),
});

router.get('/highlights', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT h.id, h.name, h.cover_url, h.updated_at,
              (SELECT count(*) FROM story_highlight_items i WHERE i.highlight_id = h.id) AS items
         FROM story_highlights h WHERE h.user_id = $1 ORDER BY h.sort_order, h.created_at`,
      [req.user.id],
    );
    res.json(rows.map(mapHighlight));
  } catch (err) { next(err); }
});

router.get('/u/:username/highlights', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT h.id, h.name, h.cover_url, h.updated_at,
              (SELECT count(*) FROM story_highlight_items i WHERE i.highlight_id = h.id) AS items
         FROM story_highlights h JOIN profiles pr ON pr.user_id = h.user_id
        WHERE pr.username_lc = $1 ORDER BY h.sort_order, h.created_at`,
      [String(req.params.username).toLowerCase()],
    );
    res.json(rows.map(mapHighlight));
  } catch (err) { next(err); }
});

router.post('/highlights', requireUser, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ message: 'Name your highlight.' });
    const id = rid();
    await query(
      'INSERT INTO story_highlights (id, user_id, name, cover_url) VALUES ($1,$2,$3,$4)',
      [id, req.user.id, name, req.body?.coverUrl ? String(req.body.coverUrl).slice(0, 1000000) : null],
    );
    res.status(201).json({ id, name, count: 0 });
  } catch (err) { next(err); }
});

router.get('/highlights/:id/items', requireUser, async (req, res, next) => {
  try {
    const own = await query('SELECT 1 FROM story_highlights WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const { rows } = await query(
      `SELECT s.id, s.media_url, s.media_kind, s.text_body, s.background, s.created_at
         FROM story_highlight_items i JOIN stories s ON s.id = i.story_id
        WHERE i.highlight_id = $1 ORDER BY i.sort_order, s.created_at`,
      [req.params.id],
    );
    res.json({ mine: own.rowCount > 0, items: rows.map((r) => ({
      id: r.id, mediaUrl: r.media_url ?? null, mediaKind: r.media_kind,
      text: r.text_body ?? null, background: r.background ?? null, createdAt: asIso(r.created_at),
    })) });
  } catch (err) { next(err); }
});

router.post('/highlights/:id/items', requireUser, async (req, res, next) => {
  try {
    const storyId = String(req.body?.storyId ?? '');
    const ownH = await query('SELECT 1 FROM story_highlights WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!ownH.rowCount) return res.status(404).json({ message: 'Highlight not found' });
    const ownS = await query('SELECT 1 FROM stories WHERE id = $1 AND author_id = $2', [storyId, req.user.id]);
    if (!ownS.rowCount) return res.status(400).json({ message: 'Pick one of your stories.' });
    await query('INSERT INTO story_highlight_items (highlight_id, story_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, storyId]);
    await query('UPDATE story_highlights SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/highlights/:id/items/:storyId', requireUser, async (req, res, next) => {
  try {
    const own = await query('SELECT 1 FROM story_highlights WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ message: 'Highlight not found' });
    await query('DELETE FROM story_highlight_items WHERE highlight_id = $1 AND story_id = $2', [req.params.id, req.params.storyId]);
    await query('UPDATE story_highlights SET updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/highlights/:id', requireUser, async (req, res, next) => {
  try {
    await query('DELETE FROM story_highlights WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= SOUNDS =================

router.get('/sounds/trending', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.title, s.artist, s.duration_ms, s.use_count,
              EXISTS (SELECT 1 FROM sound_saves ss WHERE ss.sound_id = s.id AND ss.user_id = $1) AS saved
         FROM sounds s ORDER BY s.use_count DESC, s.created_at DESC LIMIT 24`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.id, title: r.title, artist: r.artist ?? null, durationMs: r.duration_ms ?? null,
      uses: Number(r.use_count) || 0, saved: Boolean(r.saved),
    })));
  } catch (err) { next(err); }
});

router.get('/sounds/search', requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json([]);
    const { rows } = await query(
      `SELECT s.id, s.title, s.artist, s.duration_ms, s.use_count
         FROM sounds s WHERE s.title ILIKE $1 ESCAPE '\\' OR s.artist ILIKE $1 ESCAPE '\\'
        ORDER BY s.use_count DESC LIMIT 20`,
      [`%${likeEsc(q)}%`],
    );
    res.json(rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist ?? null, durationMs: r.duration_ms ?? null, uses: Number(r.use_count) || 0 })));
  } catch (err) { next(err); }
});

router.get('/sounds/saved', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.title, s.artist, s.duration_ms, s.use_count
         FROM sound_saves ss JOIN sounds s ON s.id = ss.sound_id
        WHERE ss.user_id = $1 ORDER BY ss.created_at DESC LIMIT 40`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist ?? null, durationMs: r.duration_ms ?? null, uses: Number(r.use_count) || 0, saved: true })));
  } catch (err) { next(err); }
});

router.post('/sounds/:id/save', requireUser, async (req, res, next) => {
  try {
    const save = req.body?.save !== false;
    if (save) await query('INSERT INTO sound_saves (sound_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    else await query('DELETE FROM sound_saves WHERE sound_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true, saved: save });
  } catch (err) { next(err); }
});

router.post('/sounds/:id/use', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('UPDATE sounds SET use_count = use_count + 1 WHERE id = $1 RETURNING use_count', [req.params.id]);
    res.json({ ok: true, uses: rows[0] ? Number(rows[0].use_count) : null });
  } catch (err) { next(err); }
});

// ================= UNIVERSAL SEARCH =================

router.get('/search', requireUser, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ users: [], posts: [], tags: [], sounds: [] });
    const like = `%${likeEsc(q)}%`;
    const [users, posts, tags, sounds] = await Promise.all([
      query(
        `SELECT user_id, username, display_name, is_verified FROM profiles
          WHERE username ILIKE $1 ESCAPE '\\' OR display_name ILIKE $1 ESCAPE '\\'
          ORDER BY is_verified DESC, display_name LIMIT 6`,
        [like],
      ),
      query(
        `SELECT p.id, p.body, pr.username, pr.display_name FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
          WHERE p.is_removed = false AND p.body ILIKE $1 ESCAPE '\\'
          ORDER BY p.created_at DESC LIMIT 6`,
        [like],
      ),
      query(
        `SELECT DISTINCT tag FROM post_hashtags WHERE tag ILIKE $1 ESCAPE '\\' LIMIT 6`,
        [like.replace(/[#\s]/g, '')],
      ),
      query(`SELECT id, title, artist FROM sounds WHERE title ILIKE $1 ESCAPE '\\' ORDER BY use_count DESC LIMIT 4`, [like]),
    ]);
    res.json({
      users: users.rows.map((r) => ({ id: r.user_id, username: r.username, displayName: r.display_name, avatarColor: avatarColor(r.user_id), verified: Boolean(r.is_verified) })),
      posts: posts.rows.map((r) => ({ id: r.id, body: r.body, username: r.username, displayName: r.display_name })),
      tags: tags.rows.map((r) => (r.tag.startsWith('#') ? r.tag : `#${r.tag}`)),
      sounds: sounds.rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist ?? null })),
    });
  } catch (err) { next(err); }
});

router.get('/search/history', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, query, kind, created_at FROM search_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [req.user.id]);
    res.json(rows.map((r) => ({ id: r.id, query: r.query, kind: r.kind, createdAt: asIso(r.created_at) })));
  } catch (err) { next(err); }
});

router.post('/search/history', requireUser, async (req, res, next) => {
  try {
    const q = String(req.body?.query ?? '').trim().slice(0, 120);
    if (!q) return res.status(400).json({ message: 'Empty query.' });
    await query('INSERT INTO search_history (id, user_id, query, kind) VALUES ($1,$2,$3,$4)', [rid(), req.user.id, q, String(req.body?.kind ?? 'all').slice(0, 20)]);
    await query('DELETE FROM search_history WHERE user_id = $1 AND id NOT IN (SELECT id FROM search_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20)', [req.user.id]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/search/history', requireUser, async (req, res, next) => {
  try {
    await query('DELETE FROM search_history WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= CHAT EXTRAS =================

async function memberOf(conversationId, userId) {
  const { rowCount } = await query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId]);
  return rowCount > 0;
}

router.post('/inbox/threads', requireUser, async (req, res, next) => {
  try {
    const other = String(req.body?.userId ?? '');
    if (!other || other === req.user.id) return res.status(400).json({ message: 'Pick someone else.' });
    const they = await query('SELECT user_id, username, display_name FROM profiles WHERE user_id = $1', [other]);
    if (!they.rowCount) return res.status(404).json({ message: 'User not found' });
    const existing = await query(
      `SELECT c.id FROM conversations c
        WHERE c.kind = 'dm'
          AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1)
          AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $2)
        LIMIT 1`,
      [req.user.id, other],
    );
    if (existing.rowCount) return res.json({ id: existing.rows[0].id, created: false });
    const id = rid();
    await query("INSERT INTO conversations (id, kind, created_by, created_at) VALUES ($1, 'dm', $2, now())", [id, req.user.id]);
    await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2), ($1,$3)', [id, req.user.id, other]);
    res.status(201).json({ id, created: true });
  } catch (err) { next(err); }
});

router.post('/inbox/threads/:id/archive', requireUser, async (req, res, next) => {
  try {
    if (!(await memberOf(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    await query('UPDATE conversation_members SET archived = $3 WHERE conversation_id = $1 AND user_id = $2', [req.params.id, req.user.id, req.body?.archived !== false]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/inbox/threads/:id/pin', requireUser, async (req, res, next) => {
  try {
    if (!(await memberOf(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    await query('UPDATE conversation_members SET pinned = $3 WHERE conversation_id = $1 AND user_id = $2', [req.params.id, req.user.id, req.body?.pinned !== false]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/messages/:id', requireUser, async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ message: 'Message cannot be empty.' });
    const { rows } = await query(
      "UPDATE messages SET body = $3, edited_at = now() WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL RETURNING id",
      [req.params.id, req.user.id, body],
    );
    if (!rows.length) return res.status(404).json({ message: 'Message not found or not editable.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/messages/:id', requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await query('UPDATE messages SET deleted_at = now() WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL', [req.params.id, req.user.id]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

router.post('/messages/:id/react', requireUser, async (req, res, next) => {
  try {
    const emoji = String(req.body?.emoji ?? '').trim().slice(0, 16);
    if (!emoji) return res.status(400).json({ message: 'Emoji required.' });
    const { rows } = await query('SELECT conversation_id FROM messages WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Message not found' });
    if (!(await memberOf(rows[0].conversation_id, req.user.id))) return res.status(403).json({ message: 'Not your conversation.' });
    await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, req.user.id, emoji]);
    const agg = await query(
      "SELECT emoji, count(*)::int AS n, bool_or(user_id = $2) AS mine FROM message_reactions WHERE message_id = $1 GROUP BY emoji",
      [req.params.id, req.user.id],
    );
    res.json({ ok: true, reactions: agg.rows.map((r) => ({ emoji: r.emoji, count: r.n, mine: r.mine })) });
  } catch (err) { next(err); }
});

router.delete('/messages/:id/react', requireUser, async (req, res, next) => {
  try {
    const emoji = String(req.body?.emoji ?? '').trim().slice(0, 16);
    await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [req.params.id, req.user.id, emoji]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/messages/:id/view-once', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT conversation_id, sender_id, kind, media_url FROM messages WHERE id = $1', [req.params.id]);
    const m = rows[0];
    if (!m) return res.status(404).json({ message: 'Message not found' });
    if (!m.kind.startsWith('view_once_')) return res.status(400).json({ message: 'Not a view-once message.' });
    if (!(await memberOf(m.conversation_id, req.user.id))) return res.status(403).json({ message: 'Not your conversation.' });
    if (m.sender_id === req.user.id) return res.json({ mine: true });
    const opened = await query('SELECT 1 FROM view_once_opens WHERE message_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (opened.rowCount) return res.status(410).json({ message: 'Already opened.', gone: true });
    await query('INSERT INTO view_once_opens (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    res.json({ mediaUrl: m.media_url, mediaKind: m.kind === 'view_once_video' ? 'video' : 'photo' });
  } catch (err) { next(err); }
});

router.post('/inbox/threads/:id/typing', requireUser, async (req, res, next) => {
  try {
    if (!(await memberOf(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    await query(
      "INSERT INTO typing_state (conversation_id, user_id, expires_at) VALUES ($1,$2, now() + interval '6 seconds') ON CONFLICT (conversation_id, user_id) DO UPDATE SET expires_at = now() + interval '6 seconds'",
      [req.params.id, req.user.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/inbox/threads/:id/typing', requireUser, async (req, res, next) => {
  try {
    if (!(await memberOf(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const { rows } = await query(
      `SELECT pr.user_id, pr.username, pr.display_name FROM typing_state t JOIN profiles pr ON pr.user_id = t.user_id
        WHERE t.conversation_id = $1 AND t.user_id <> $2 AND t.expires_at > now()`,
      [req.params.id, req.user.id],
    );
    res.json(rows.map((r) => ({ userId: r.user_id, username: r.username, displayName: r.display_name })));
  } catch (err) { next(err); }
});

router.post('/inbox/threads/:id/schedule', requireUser, async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim().slice(0, 4000);
    const sendAt = new Date(req.body?.sendAt ?? '');
    if (!body) return res.status(400).json({ message: 'Message cannot be empty.' });
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() + 30_000) return res.status(400).json({ message: 'Pick a time at least a minute from now.' });
    if (sendAt.getTime() > Date.now() + 365 * 24 * 3600 * 1000) return res.status(400).json({ message: 'That is too far in the future.' });
    if (!(await memberOf(req.params.id, req.user.id))) return res.status(404).json({ message: 'Conversation not found' });
    const id = rid();
    await query(
      "INSERT INTO scheduled_messages (id, conversation_id, sender_id, kind, body, send_at, status) VALUES ($1,$2,$3,'text',$4,$5,'pending')",
      [id, req.params.id, req.user.id, body, sendAt],
    );
    res.status(201).json({ id, sendAt: sendAt.toISOString() });
  } catch (err) { next(err); }
});

router.get('/inbox/scheduled', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.conversation_id, s.body, s.send_at, c.title,
              CASE WHEN c.kind = 'dm' THEN (SELECT coalesce(p2.display_name, 'Conversation') FROM conversation_members cm2 JOIN profiles p2 ON p2.user_id = cm2.user_id WHERE cm2.conversation_id = c.id AND cm2.user_id <> $1 LIMIT 1) ELSE coalesce(c.title, 'Group') END AS name
         FROM scheduled_messages s JOIN conversations c ON c.id = s.conversation_id
        WHERE s.sender_id = $1 AND s.status = 'pending' ORDER BY s.send_at ASC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, threadName: r.name ?? 'Conversation', body: r.body, sendAt: asIso(r.send_at) })));
  } catch (err) { next(err); }
});

router.delete('/inbox/scheduled/:id', requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await query("UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1 AND sender_id = $2 AND status = 'pending'", [req.params.id, req.user.id]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

// ================= SAVED COLLECTIONS =================

router.get('/saved/collections', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.name, c.created_at,
              (SELECT count(*) FROM saved_collection_items i WHERE i.collection_id = c.id) AS items
         FROM saved_collections c WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.items), createdAt: asIso(r.created_at) })));
  } catch (err) { next(err); }
});

router.post('/saved/collections', requireUser, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ message: 'Name the collection.' });
    const id = rid();
    await query('INSERT INTO saved_collections (id, user_id, name) VALUES ($1,$2,$3)', [id, req.user.id, name]);
    res.status(201).json({ id, name, count: 0 });
  } catch (err) { next(err); }
});

router.delete('/saved/collections/:id', requireUser, async (req, res, next) => {
  try {
    await query('DELETE FROM saved_collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/saved/collections/:id/items', requireUser, async (req, res, next) => {
  try {
    const own = await query('SELECT 1 FROM saved_collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ message: 'Collection not found' });
    const { rows } = await query(
      `SELECT p.id, p.body, p.kind, p.created_at, p.view_count, p.repost_of_id,
              pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified,
              (SELECT count(*) FROM post_likes pl WHERE pl.post_id = p.id) AS likes,
              (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.is_removed = false) AS comments,
              (SELECT count(*) FROM posts r WHERE r.repost_of_id = p.id) AS reposts,
              true AS bookmarked,
              (p.boosted_until IS NOT NULL AND p.boosted_until > now()) AS boosted,
              EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1) AS liked,
              (SELECT kind FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.sort_order, pm.id LIMIT 1) AS media_kind
         FROM saved_collection_items i JOIN posts p ON p.id = i.post_id JOIN profiles pr ON pr.user_id = p.author_id
        WHERE i.collection_id = $2 AND p.is_removed = false
        ORDER BY i.created_at DESC LIMIT 60`,
      [req.user.id, req.params.id],
    );
    res.json({ items: rows.map(mapMiniPost) });
  } catch (err) { next(err); }
});

router.post('/saved/collections/:id/items', requireUser, async (req, res, next) => {
  try {
    const postId = String(req.body?.postId ?? '');
    const own = await query('SELECT 1 FROM saved_collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ message: 'Collection not found' });
    const exists = await query('SELECT 1 FROM posts WHERE id = $1', [postId]);
    if (!exists.rowCount) return res.status(400).json({ message: 'Post not found.' });
    await query('INSERT INTO saved_collection_items (collection_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, postId]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/saved/collections/:id/items/:postId', requireUser, async (req, res, next) => {
  try {
    const own = await query('SELECT 1 FROM saved_collections WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ message: 'Collection not found' });
    await query('DELETE FROM saved_collection_items WHERE collection_id = $1 AND post_id = $2', [req.params.id, req.params.postId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= POST LISTS (profile tabs) =================

const POST_LIST_SELECT = `
  SELECT p.id, p.body, p.kind, p.created_at, p.view_count, p.repost_of_id,
         pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified,
         (SELECT count(*) FROM post_likes pl WHERE pl.post_id = p.id) AS likes,
         (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.is_removed = false) AS comments,
         (SELECT count(*) FROM posts r WHERE r.repost_of_id = p.id) AS reposts,
         (p.boosted_until IS NOT NULL AND p.boosted_until > now()) AS boosted,
         EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1) AS liked,
         EXISTS (SELECT 1 FROM bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS bookmarked,
         (SELECT kind FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.sort_order, pm.id LIMIT 1) AS media_kind
    FROM posts p JOIN profiles pr ON pr.user_id = p.author_id`;

const kindFilter = (kind, startIdx) => {
  if (kind === 'video') return 'AND p.kind = \'video\'';
  if (kind === 'repost') return 'AND p.repost_of_id IS NOT NULL';
  if (kind === 'post') return 'AND p.kind = \'post\' AND p.repost_of_id IS NULL';
  return '';
};

router.get('/me/posts', requireUser, async (req, res, next) => {
  try {
    const kind = String(req.query.kind ?? 'all');
    const { rows } = await query(`${POST_LIST_SELECT} WHERE p.is_removed = false AND p.author_id = $2 ${kindFilter(kind, 2)} ORDER BY p.created_at DESC LIMIT 40`, [req.user.id, req.user.id]);
    res.json({ items: rows.map(mapMiniPost) });
  } catch (err) { next(err); }
});

router.get('/u/:username/posts', requireUser, async (req, res, next) => {
  try {
    const kind = String(req.query.kind ?? 'all');
    const { rows } = await query(`${POST_LIST_SELECT} WHERE p.is_removed = false AND pr.username_lc = $2 ${kindFilter(kind, 2)} ORDER BY p.created_at DESC LIMIT 40`, [req.user.id, String(req.params.username).toLowerCase()]);
    res.json({ items: rows.map(mapMiniPost) });
  } catch (err) { next(err); }
});

// ================= TAG FOLLOWS =================

router.get('/tags/following', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT tag_lc FROM tag_follows WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(rows.map((r) => `#${r.tag_lc}`));
  } catch (err) { next(err); }
});

router.post('/tags/:tag/follow', requireUser, async (req, res, next) => {
  try {
    const tag = cleanTag(req.params.tag);
    if (!tag) return res.status(400).json({ message: 'Bad tag.' });
    if (req.body?.follow !== false) await query('INSERT INTO tag_follows (user_id, tag_lc) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, tag]);
    else await query('DELETE FROM tag_follows WHERE user_id = $1 AND tag_lc = $2', [req.user.id, tag]);
    res.json({ ok: true, following: req.body?.follow !== false });
  } catch (err) { next(err); }
});

// ================= USERNAME CHECK =================

router.get('/username/available', requireUser, async (req, res, next) => {
  try {
    const u = String(req.query.u ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return res.json({ available: false, reason: 'Use 3–20 lowercase letters, numbers or underscores.' });
    const { rowCount } = await query('SELECT 1 FROM profiles WHERE username_lc = $1 AND user_id <> $2', [u, req.user.id]);
    res.json({ available: rowCount === 0 });
  } catch (err) { next(err); }
});

// ================= GHOST MAP + PINGS =================

router.get('/map/ghost', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT ghost_mode FROM profiles WHERE user_id = $1', [req.user.id]);
    res.json({ enabled: Boolean(rows[0]?.ghost_mode) });
  } catch (err) { next(err); }
});

router.put('/map/ghost', requireUser, async (req, res, next) => {
  try {
    await query('UPDATE profiles SET ghost_mode = $2 WHERE user_id = $1', [req.user.id, req.body?.enabled === true]);
    res.json({ enabled: req.body?.enabled === true });
  } catch (err) { next(err); }
});

router.get('/map/friends', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT pr.user_id, pr.username, pr.display_name, pr.is_verified, pr.show_online, pr.last_seen_at
         FROM profiles pr
        WHERE pr.user_id <> $1
          AND pr.ghost_mode = false
          AND pr.user_id IN (${FRIENDS_SQL.replace(/\$1/g, '$1')})
        ORDER BY pr.display_name LIMIT 100`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.user_id, username: r.username, displayName: r.display_name,
      avatarColor: avatarColor(r.user_id), verified: Boolean(r.is_verified),
      online: Boolean(r.show_online) && r.last_seen_at && (Date.now() - new Date(r.last_seen_at).getTime()) < 5 * 60_000,
    })));
  } catch (err) { next(err); }
});

router.post('/map/ping', requireUser, async (req, res, next) => {
  try {
    const to = String(req.body?.toUserId ?? '');
    if (!to || to === req.user.id) return res.status(400).json({ message: 'Pick a friend.' });
    const friend = await query('SELECT 1 FROM profiles pr WHERE pr.user_id = $2 AND EXISTS (SELECT 1 FROM (' + FRIENDS_SQL + ') f WHERE f.following_id = $2)', [req.user.id, to]);
    if (!friend.rowCount) return res.status(400).json({ message: 'Pings only go to mutual friends.' });
    await query('INSERT INTO ephemeral_pings (id, from_user_id, to_user_id) VALUES ($1,$2,$3)', [rid(), req.user.id, to]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/map/pings', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.created_at, pr.user_id AS from_id, pr.username, pr.display_name
         FROM ephemeral_pings p JOIN profiles pr ON pr.user_id = p.from_user_id
        WHERE p.to_user_id = $1 AND p.created_at > now() - interval '24 hours'
        ORDER BY p.created_at DESC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, fromId: r.from_id, username: r.username, displayName: r.display_name, avatarColor: avatarColor(r.from_id), createdAt: asIso(r.created_at) })));
  } catch (err) { next(err); }
});

// ================= ADMIN: USERS, WARNINGS, SANCTIONS =================

router.get('/admin/users', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${likeEsc(q)}%`;
    const { rows } = await query(
      `SELECT p.user_id, p.username, p.display_name, p.role, p.is_suspended, p.is_banned,
              (SELECT count(*) FROM sanctions s WHERE s.user_id = p.user_id AND s.status = 'active') AS active_sanctions,
              (SELECT count(*) FROM user_warnings w WHERE w.user_id = p.user_id) AS warnings
         FROM profiles p
        WHERE p.username ILIKE $1 ESCAPE '\\' OR p.display_name ILIKE $1 ESCAPE '\\'
        ORDER BY p.role DESC, p.username LIMIT 20`,
      [like],
    );
    res.json(rows.map((r) => ({
      id: r.user_id, username: r.username, displayName: r.display_name, avatarColor: avatarColor(r.user_id),
      role: r.role, suspended: Boolean(r.is_suspended), banned: Boolean(r.is_banned),
      activeSanctions: Number(r.active_sanctions), warnings: Number(r.warnings),
    })));
  } catch (err) { next(err); }
});

router.get('/admin/users/:id', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM profiles WHERE user_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const p = rows[0];
    const sanctions = await query(
      "SELECT id, kind, capabilities, reason, ends_at, status, created_at FROM sanctions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10",
      [req.params.id],
    );
    res.json({
      id: p.user_id, username: p.username, displayName: p.display_name, bio: p.bio ?? '',
      role: p.role, suspended: Boolean(p.is_suspended), banned: Boolean(p.is_banned),
      verified: Boolean(p.is_verified), createdAt: asIso(p.created_at),
      sanctions: sanctions.rows.map((s) => ({
        id: s.id, kind: s.kind, capabilities: s.capabilities ?? {}, reason: s.reason ?? '',
        endsAt: s.ends_at ? asIso(s.ends_at) : null, status: s.status, createdAt: asIso(s.created_at),
      })),
    });
  } catch (err) { next(err); }
});

router.post('/admin/warnings', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const userId = String(req.body?.userId ?? '');
    const category = String(req.body?.category ?? 'general').slice(0, 60);
    const body = String(req.body?.body ?? '').slice(0, 1000);
    const target = await query('SELECT 1 FROM profiles WHERE user_id = $1', [userId]);
    if (!target.rowCount) return res.status(404).json({ message: 'User not found' });
    await query(
      'INSERT INTO user_warnings (id, user_id, actor_id, category, body, target_kind, target_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [rid(), userId, req.user.id, category, body, String(req.body?.targetKind ?? 'user').slice(0, 40), req.body?.targetId ? String(req.body.targetId).slice(0, 80) : null],
    );
    await query(
      "INSERT INTO notifications (id, user_id, kind, actor_id, body) VALUES ($1,$2,'warning',$3,$4)",
      [rid(), userId, req.user.id, `Warning from NYX moderation (${category})${body ? `: ${body.slice(0, 140)}` : ''}`],
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/admin/sanctions', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const userId = String(req.body?.userId ?? '');
    const kind = ['restrict', 'suspend'].includes(String(req.body?.kind)) ? String(req.body.kind) : 'restrict';
    const capabilities = req.body?.capabilities && typeof req.body.capabilities === 'object' ? req.body.capabilities : {};
    const reason = String(req.body?.reason ?? '').slice(0, 1000);
    const hours = Number(req.body?.hours) > 0 ? Math.min(24 * 365, Number(req.body.hours)) : null;
    const target = await query('SELECT 1 FROM profiles WHERE user_id = $1', [userId]);
    if (!target.rowCount) return res.status(404).json({ message: 'User not found' });
    const id = rid();
    await query(
      `INSERT INTO sanctions (id, user_id, actor_id, kind, capabilities, reason, starts_at, ends_at, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6, now(), $7, 'active')`,
      [id, userId, req.user.id, kind, JSON.stringify(capabilities), reason, hours ? new Date(Date.now() + hours * 3600_000) : null],
    );
    await query(
      "INSERT INTO notifications (id, user_id, kind, actor_id, body) VALUES ($1,$2,'sanction',$3,$4)",
      [rid(), userId, req.user.id, kind === 'suspend' ? 'Your account is suspended pending review.' : `Your account is restricted${reason ? `: ${reason.slice(0, 140)}` : ''}`],
    );
    res.status(201).json({ ok: true, id });
  } catch (err) { next(err); }
});

router.post('/admin/sanctions/:id/revoke', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await query("UPDATE sanctions SET status = 'revoked' WHERE id = $1 AND status = 'active'", [req.params.id]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

router.get('/admin/sanctions', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const status = String(req.query.status ?? 'active');
    const { rows } = await query(
      `SELECT s.id, s.kind, s.capabilities, s.reason, s.starts_at, s.ends_at, s.status,
              pr.user_id AS target_id, pr.username, pr.display_name
         FROM sanctions s JOIN profiles pr ON pr.user_id = s.user_id
        WHERE s.status = $1 ORDER BY s.starts_at DESC LIMIT 50`,
      [status],
    );
    res.json(rows.map((r) => ({
      id: r.id, kind: r.kind, capabilities: r.capabilities ?? {}, reason: r.reason ?? '',
      startsAt: asIso(r.starts_at), endsAt: r.ends_at ? asIso(r.ends_at) : null, status: r.status,
      targetId: r.target_id, username: r.username, displayName: r.display_name,
    })));
  } catch (err) { next(err); }
});

router.get('/me/sanctions', requireUser, async (req, res, next) => {
  try {
    const sanctions = await query(
      "SELECT id, kind, capabilities, reason, ends_at, status FROM sanctions WHERE user_id = $1 AND status = 'active' ORDER BY starts_at DESC LIMIT 5",
      [req.user.id],
    );
    const warnings = await query(
      'SELECT id, category, body, created_at FROM user_warnings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 3',
      [req.user.id],
    );
    res.json({
      sanctions: sanctions.rows.map((s) => ({ id: s.id, kind: s.kind, capabilities: s.capabilities ?? {}, reason: s.reason ?? '', endsAt: s.ends_at ? asIso(s.ends_at) : null })),
      warnings: warnings.rows.map((w) => ({ id: w.id, category: w.category, body: w.body, createdAt: asIso(w.created_at) })),
    });
  } catch (err) { next(err); }
});

router.post('/admin/announce', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim().slice(0, 1000);
    if (body.length < 4) return res.status(400).json({ message: 'Say something first.' });
    const { rowCount } = await query(
      "INSERT INTO notifications (id, user_id, kind, actor_id, body) SELECT gen_random_uuid()::text, user_id, 'announcement', $1, $2 FROM profiles",
      [req.user.id, body],
    );
    res.status(201).json({ ok: true, recipients: rowCount });
  } catch (err) { next(err); }
});

// ================= STORY VIEWERS + REACTIONS =================

router.get('/stories/:id/viewers', requireUser, async (req, res, next) => {
  try {
    const own = await query('SELECT 1 FROM stories WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ message: 'Story not found' });
    const { rows } = await query(
      `SELECT pr.user_id, pr.username, pr.display_name, pr.is_verified, sv.viewed_at
         FROM story_views sv JOIN profiles pr ON pr.user_id = sv.user_id
        WHERE sv.story_id = $1 ORDER BY sv.viewed_at DESC LIMIT 100`,
      [req.params.id],
    );
    res.json(rows.map((r) => ({ id: r.user_id, username: r.username, displayName: r.display_name, avatarColor: avatarColor(r.user_id), verified: Boolean(r.is_verified), viewedAt: asIso(r.viewed_at) })));
  } catch (err) { next(err); }
});

router.post('/stories/:id/react', requireUser, async (req, res, next) => {
  try {
    const emoji = String(req.body?.emoji ?? '').trim().slice(0, 16);
    if (!emoji) return res.status(400).json({ message: 'Emoji required.' });
    const exists = await query('SELECT 1 FROM stories WHERE id = $1', [req.params.id]);
    if (!exists.rowCount) return res.status(404).json({ message: 'Story not found' });
    await query('INSERT INTO story_reactions (story_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT (story_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()', [req.params.id, req.user.id, emoji]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/stories/:id/react', requireUser, async (req, res, next) => {
  try {
    await query('DELETE FROM story_reactions WHERE story_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= BOOST POST =================

const BOOST_PRICE = 100;
const BOOST_DAYS = 7;

router.post('/studio/boost', requireUser, async (req, res, next) => {
  const client = await import('../db.js').then((m) => m.pool.connect());
  try {
    const postId = String(req.body?.postId ?? '');
    if (!postId) return res.status(400).json({ message: 'Pick a post.' });
    await client.query('BEGIN');
    const post = await client.query('SELECT id FROM posts WHERE id = $1 AND author_id = $2 AND is_removed = false FOR UPDATE', [postId, req.user.id]);
    if (!post.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Post not found.' }); }
    const w = await client.query('SELECT balance FROM coin_wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const balance = Number(w.rows[0]?.balance ?? 0);
    if (balance < BOOST_PRICE) { await client.query('ROLLBACK'); return res.status(400).json({ message: `Boosts cost ${BOOST_PRICE} Coins.` }); }
    const after = balance - BOOST_PRICE;
    await client.query('UPDATE coin_wallets SET balance = $2, updated_at = now() WHERE user_id = $1', [req.user.id, after]);
    await client.query(
      'INSERT INTO coin_ledger (id, user_id, kind, direction, amount, balance_before, balance_after, reason, related_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [rid(), req.user.id, 'boost_spend', 'out', BOOST_PRICE, balance, after, 'Post boost (7 days)', postId],
    );
    const { rows } = await client.query(
      "UPDATE posts SET boosted_until = greatest(coalesce(boosted_until, now()), now()) + ($2 || ' days')::interval WHERE id = $1 RETURNING boosted_until",
      [postId, String(BOOST_DAYS)],
    );
    await client.query('COMMIT');
    res.json({ ok: true, balance: after, boostedUntil: asIso(rows[0].boosted_until), price: BOOST_PRICE, days: BOOST_DAYS });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    next(err);
  } finally { client.release(); }
});

// ================= CHALLENGES =================

router.post('/challenges/:id/submit', requireUser, async (req, res, next) => {
  try {
    const postId = String(req.body?.postId ?? '');
    if (!postId) return res.status(400).json({ message: 'Pick a post to enter.' });
    const challenge = await query('SELECT 1 FROM challenges WHERE id = $1', [req.params.id]);
    if (!challenge.rowCount) return res.status(404).json({ message: 'Challenge not found' });
    const post = await query('SELECT 1 FROM posts WHERE id = $1 AND author_id = $2', [postId, req.user.id]);
    if (!post.rowCount) return res.status(400).json({ message: 'You can only enter one of your own posts.' });
    await query('INSERT INTO challenge_entries (challenge_id, video_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, postId, req.user.id]);
    const { rows } = await query('SELECT count(*)::int AS n FROM challenge_entries WHERE challenge_id = $1', [req.params.id]);
    res.json({ ok: true, entries: rows[0].n });
  } catch (err) { next(err); }
});

// ================= LIVE =================

router.post('/live/start', requireUser, async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim().slice(0, 120);
    if (title.length < 3) return res.status(400).json({ message: 'Give your live a title (min 3 characters).' });
    const active = await query("SELECT id FROM live_streams WHERE host_id = $1 AND status = 'live' LIMIT 1", [req.user.id]);
    if (active.rowCount) return res.json({ id: active.rows[0].id, alreadyLive: true });
    const id = rid();
    await query('INSERT INTO live_streams (id, host_id, title, status, room_code) VALUES ($1,$2,$3,$4,$5)', [id, req.user.id, title, 'live', rid().slice(0, 8)]);
    res.status(201).json({ id, title });
  } catch (err) { next(err); }
});

router.post('/live/:id/end', requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await query("UPDATE live_streams SET status = 'ended', ended_at = now() WHERE id = $1 AND host_id = $2 AND status = 'live'", [req.params.id, req.user.id]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

router.get('/live/hosting', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT id, title, started_at, viewer_peak FROM live_streams WHERE host_id = $1 AND status = 'live' ORDER BY started_at DESC LIMIT 1",
      [req.user.id],
    );
    res.json(rows[0] ? { id: rows[0].id, title: rows[0].title, startedAt: asIso(rows[0].started_at), viewers: Number(rows[0].viewer_peak) || 0 } : null);
  } catch (err) { next(err); }
});

const GIFT_CATALOG = { heart: { label: 'Heart', price: 5 }, star: { label: 'Star', price: 20 }, rocket: { label: 'Rocket', price: 100 }, crown: { label: 'Crown', price: 500 } };

router.get('/live/gifts', requireUser, async (_req, res) => {
  res.json(Object.entries(GIFT_CATALOG).map(([id, v]) => ({ id, ...v })));
});

router.post('/live/:id/gift', requireUser, async (req, res, next) => {
  const client = await import('../db.js').then((m) => m.pool.connect());
  try {
    const gift = GIFT_CATALOG[String(req.body?.giftId ?? '')];
    if (!gift) return res.status(400).json({ message: 'Unknown gift.' });
    const live = await query("SELECT host_id FROM live_streams WHERE id = $1 AND status = 'live'", [req.params.id]);
    if (!live.rowCount) return res.status(404).json({ message: 'This live has ended.' });
    const hostId = live.rows[0].host_id;
    if (hostId === req.user.id) return res.status(400).json({ message: 'You cannot gift yourself.' });
    await client.query('BEGIN');
    const w = await client.query('SELECT balance FROM coin_wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    const balance = Number(w.rows[0]?.balance ?? 0);
    if (balance < gift.price) { await client.query('ROLLBACK'); return res.status(400).json({ message: `${gift.label} costs ${gift.price} Coins.` }); }
    const after = balance - gift.price;
    await client.query('UPDATE coin_wallets SET balance = $2, updated_at = now() WHERE user_id = $1', [req.user.id, after]);
    await client.query(
      'INSERT INTO coin_ledger (id, user_id, kind, direction, amount, balance_before, balance_after, reason, related_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [rid(), req.user.id, 'gift_sent', 'out', gift.price, balance, after, `Gift: ${gift.label}`, req.params.id],
    );
    const hostWallet = await client.query('SELECT balance FROM coin_wallets WHERE user_id = $1 FOR UPDATE', [hostId]);
    const hostBefore = Number(hostWallet.rows[0]?.balance ?? 0);
    await client.query('UPDATE coin_wallets SET balance = $2, updated_at = now() WHERE user_id = $1', [hostId, hostBefore + gift.price]);
    await client.query(
      'INSERT INTO coin_ledger (id, user_id, kind, direction, amount, balance_before, balance_after, reason, related_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [rid(), hostId, 'gift_received', 'in', gift.price, hostBefore, hostBefore + gift.price, `Gift: ${gift.label}`, req.params.id],
    );
    await client.query(
      "INSERT INTO notifications (id, user_id, kind, actor_id, entity_id, body) VALUES ($1,$2,'gift',$3,$4,$5)",
      [rid(), hostId, req.user.id, req.params.id, `sent you a ${gift.label} in your live`],
    );
    await client.query('COMMIT');
    res.json({ ok: true, balance: after });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    next(err);
  } finally { client.release(); }
});


// ================= POST MEDIA =================

router.post('/posts/:id/media', requireUser, async (req, res, next) => {
  try {
    const kind = req.body?.kind === 'video' ? 'video' : 'image';
    const url = String(req.body?.url ?? '');
    if (!url || url.length > 1_500_000) return res.status(400).json({ message: 'Media is missing or too large.' });
    const own = await query('SELECT 1 FROM posts WHERE id = $1 AND author_id = $2 AND is_removed = false', [req.params.id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ message: 'Post not found' });
    const count = await query('SELECT count(*)::int AS n FROM post_media WHERE post_id = $1', [req.params.id]);
    if (count.rows[0].n >= 4) return res.status(400).json({ message: 'Up to 4 attachments per post.' });
    const id = rid();
    await query(
      'INSERT INTO post_media (id, post_id, kind, url, thumb_url, width, height, sort_order) VALUES ($1,$2,$3,$4,NULL,$5,$6,$7)',
      [id, req.params.id, kind, url, Number(req.body?.width) || null, Number(req.body?.height) || null, count.rows[0].n],
    );
    res.status(201).json({ id, sortOrder: count.rows[0].n });
  } catch (err) { next(err); }
});
// ================= DRAFTS =================

router.get('/drafts', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, payload, updated_at FROM video_drafts WHERE author_id = $1 ORDER BY updated_at DESC LIMIT 30',
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, payload: r.payload ?? {}, updatedAt: asIso(r.updated_at) })));
  } catch (err) { next(err); }
});

router.post('/drafts', requireUser, async (req, res, next) => {
  try {
    const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
    const body = String(payload.body ?? '').slice(0, 2800);
    if (!body.trim() && !payload.mediaUrl) return res.status(400).json({ message: 'Nothing to save yet.' });
    const id = rid();
    await query('INSERT INTO video_drafts (id, author_id, payload) VALUES ($1,$2,$3::jsonb)', [id, req.user.id, JSON.stringify({ tab: payload.tab ?? 'post', body, mediaUrl: payload.mediaUrl ?? null, location: payload.location ?? null, savedAt: new Date().toISOString() })]);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.delete('/drafts/:id', requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM video_drafts WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

// ================= STATUSES (24h) =================

async function mutualFriendIds(userId) {
  const { rows } = await query(
    `SELECT following_id FROM follows WHERE follower_id = $1
     INTERSECT SELECT follower_id FROM follows WHERE following_id = $1`,
    [userId],
  );
  return rows.map((r) => r.following_id);
}

router.get('/statuses', requireUser, async (req, res, next) => {
  try {
    const me = req.user.id;
    const friendIds = await mutualFriendIds(me);
    const { rows } = await query(
      `SELECT s.id, s.author_id, s.media_url, s.media_kind, s.text_body, s.background, s.audience, s.expires_at, s.created_at,
              pr.username, pr.display_name, pr.avatar_color, pr.is_verified
         FROM statuses s JOIN profiles pr ON pr.user_id = s.author_id
        WHERE s.expires_at > now()
          AND (s.author_id = $1 OR s.audience = 'everyone'
               OR (s.audience = 'friends' AND s.author_id = ANY($2::text[]))
               OR (s.audience = 'only' AND EXISTS (SELECT 1 FROM status_audience sa WHERE sa.status_id = s.id AND sa.user_id = $1 AND sa.mode = 'only'))
               OR (s.audience = 'except' AND NOT EXISTS (SELECT 1 FROM status_audience sa WHERE sa.status_id = s.id AND sa.user_id = $1 AND sa.mode = 'except') AND s.author_id = ANY($2::text[])))
        ORDER BY s.created_at DESC LIMIT 60`,
      [me, friendIds],
    );
    const viewed = rows.length
      ? (await query('SELECT status_id FROM status_views WHERE user_id = $1 AND status_id = ANY($2::text[])', [me, rows.map((r) => r.id)])).rows.map((r) => r.status_id)
      : [];
    const viewedSet = new Set(viewed);
    res.json(rows.map((r) => ({
      id: r.id, authorId: r.author_id, username: r.username, displayName: r.display_name,
      avatarColor: r.avatar_color, verified: r.is_verified,
      mediaKind: r.media_kind, mediaUrl: r.media_url, textBody: r.text_body, background: r.background,
      audience: r.audience, createdAt: asIso(r.created_at), expiresAt: asIso(r.expires_at),
      mine: r.author_id === me, seen: viewedSet.has(r.id),
    })));
  } catch (err) { next(err); }
});

router.get('/statuses/mine', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, media_url, media_kind, text_body, background, audience, expires_at, created_at
         FROM statuses WHERE author_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 20`,
      [req.user.id],
    );
    const ids = rows.map((r) => r.id);
    const views = ids.length
      ? (await query('SELECT status_id, count(*)::int AS n FROM status_views WHERE status_id = ANY($1::text[]) GROUP BY status_id', [ids])).rows
      : [];
    const viewMap = Object.fromEntries(views.map((v) => [v.status_id, v.n]));
    res.json(rows.map((r) => ({
      id: r.id, mediaKind: r.media_kind, mediaUrl: r.media_url, textBody: r.text_body, background: r.background,
      audience: r.audience, createdAt: asIso(r.created_at), expiresAt: asIso(r.expires_at), views: viewMap[r.id] ?? 0,
    })));
  } catch (err) { next(err); }
});

router.post('/statuses', requireUser, async (req, res, next) => {
  try {
    const mediaKind = ['text', 'photo', 'video'].includes(req.body?.mediaKind) ? req.body.mediaKind : 'text';
    const mediaUrl = req.body?.mediaUrl ? String(req.body.mediaUrl).slice(0, 1_500_000) : null;
    const textBody = String(req.body?.textBody ?? '').trim().slice(0, 500);
    const background = req.body?.background ? String(req.body.background).slice(0, 32) : '#0d1420';
    const audience = ['everyone', 'friends', 'only', 'except'].includes(req.body?.audience) ? req.body.audience : 'friends';
    if (mediaKind === 'text' && !textBody) return res.status(400).json({ message: 'Write something for your status.' });
    if (mediaKind !== 'text' && !mediaUrl) return res.status(400).json({ message: 'Media is missing.' });
    const id = rid();
    await query(
      `INSERT INTO statuses (id, author_id, media_url, media_kind, text_body, background, audience, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '24 hours', now())`,
      [id, req.user.id, mediaUrl, mediaKind === 'photo' ? 'photo' : mediaKind, textBody || null, background, audience],
    );
    const pick = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(String))].slice(0, 200);
    const ids = audience === 'only' ? pick(req.body?.onlyUserIds) : audience === 'except' ? pick(req.body?.exceptUserIds) : [];
    for (const uid of ids) {
      await query('INSERT INTO status_audience (status_id, user_id, mode) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, uid, audience]);
    }
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.post('/statuses/:id/view', requireUser, async (req, res, next) => {
  try {
    await query('INSERT INTO status_views (status_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/statuses/:id', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.author_id, s.media_url, s.media_kind, s.text_body, s.background, s.audience, s.expires_at, s.created_at,
              pr.username, pr.display_name, pr.avatar_color, pr.is_verified
         FROM statuses s JOIN profiles pr ON pr.user_id = s.author_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ message: 'That status has expired.' });
    const r = rows[0];
    const views = await query('SELECT count(*)::int AS n FROM status_views WHERE status_id = $1', [req.params.id]);
    res.json({
      id: r.id, authorId: r.author_id, username: r.username, displayName: r.display_name,
      avatarColor: r.avatar_color, verified: r.is_verified,
      mediaKind: r.media_kind, mediaUrl: r.media_url, textBody: r.text_body, background: r.background,
      audience: r.audience, createdAt: asIso(r.created_at), expiresAt: asIso(r.expires_at),
      views: views.rows[0].n, mine: r.author_id === req.user.id,
    });
  } catch (err) { next(err); }
});

router.get('/statuses/:id/viewers', requireUser, async (req, res, next) => {
  try {
    const own = await query('SELECT 1 FROM statuses WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ message: 'Only the author can see viewers.' });
    const { rows } = await query(
      `SELECT sv.user_id, sv.created_at, pr.username, pr.display_name, pr.avatar_color, pr.is_verified
         FROM status_views sv JOIN profiles pr ON pr.user_id = sv.user_id
        WHERE sv.status_id = $1 ORDER BY sv.created_at DESC LIMIT 100`,
      [req.params.id],
    );
    res.json(rows.map((r) => ({ id: r.user_id, username: r.username, displayName: r.display_name, avatarColor: r.avatar_color, verified: r.is_verified, viewedAt: asIso(r.created_at) })));
  } catch (err) { next(err); }
});

// ================= FAVORITE / MARK UNREAD =================

router.post('/inbox/threads/:id/favorite', requireUser, async (req, res, next) => {
  try {
    const favorite = req.body?.favorite !== false;
    await query('UPDATE conversation_members SET favorite = $3 WHERE conversation_id = $1 AND user_id = $2', [req.params.id, req.user.id, favorite]);
    res.json({ ok: true, favorite });
  } catch (err) { next(err); }
});

router.post('/inbox/threads/:id/unread', requireUser, async (req, res, next) => {
  try {
    const marked = req.body?.marked !== false;
    await query('UPDATE conversation_members SET marked_unread = $3 WHERE conversation_id = $1 AND user_id = $2', [req.params.id, req.user.id, marked]);
    res.json({ ok: true, marked });
  } catch (err) { next(err); }
});

// ================= INBOX LISTS =================

router.get('/inbox/lists', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.created_at,
              (SELECT count(*) FROM inbox_list_chats ilc WHERE ilc.list_id = l.id)::int AS count,
              coalesce(array_agg(ilc.conversation_id) FILTER (WHERE ilc.conversation_id IS NOT NULL), '{}') AS chat_ids
         FROM inbox_lists l LEFT JOIN inbox_list_chats ilc ON ilc.list_id = l.id
        WHERE l.user_id = $1
        GROUP BY l.id
        ORDER BY l.created_at ASC`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, title: r.title, count: Number(r.count) || 0, chatIds: r.chat_ids ?? [], createdAt: asIso(r.created_at) })));
  } catch (err) { next(err); }
});

router.post('/inbox/lists', requireUser, async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim().slice(0, 32);
    if (!title) return res.status(400).json({ message: 'Name the list.' });
    const id = rid();
    const ids = [...new Set((Array.isArray(req.body?.conversationIds) ? req.body.conversationIds : []).map(String))].slice(0, 200);
    await query('INSERT INTO inbox_lists (id, user_id, title) VALUES ($1,$2,$3)', [id, req.user.id, title]);
    for (const conversationId of ids) {
      await query('INSERT INTO inbox_list_chats (list_id, conversation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, conversationId]);
    }
    res.status(201).json({ id, title, count: ids.length, chatIds: ids });
  } catch (err) { next(err); }
});

router.delete('/inbox/lists/:id', requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM inbox_lists WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

router.post('/inbox/lists/:id/chats', requireUser, async (req, res, next) => {
  try {
    const list = await query('SELECT 1 FROM inbox_lists WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!list.rowCount) return res.status(404).json({ message: 'List not found' });
    const conversationId = String(req.body?.conversationId ?? '');
    const member = await query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, req.user.id]);
    if (!member.rowCount) return res.status(404).json({ message: 'Not a member of that chat' });
    if (req.body?.add === false) {
      await query('DELETE FROM inbox_list_chats WHERE list_id = $1 AND conversation_id = $2', [req.params.id, conversationId]);
      return res.json({ ok: true, added: false });
    }
    await query('INSERT INTO inbox_list_chats (list_id, conversation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, conversationId]);
    res.json({ ok: true, added: true });
  } catch (err) { next(err); }
});

// ================= STARRED MESSAGES =================

router.get('/inbox/starred', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ms.message_id AS id, msg.conversation_id, msg.body, msg.kind, ms.created_at,
              CASE WHEN c.kind = 'dm' THEN (
                SELECT coalesce(p2.display_name, 'Conversation') FROM conversation_members cm2
                JOIN profiles p2 ON p2.user_id = cm2.user_id
                WHERE cm2.conversation_id = c.id AND cm2.user_id <> $1 LIMIT 1)
              ELSE coalesce(c.title, 'Group') END AS title
         FROM message_stars ms
         JOIN messages msg ON msg.id = ms.message_id
         JOIN conversations c ON c.id = msg.conversation_id
        WHERE ms.user_id = $1
        ORDER BY ms.created_at DESC LIMIT 100`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, body: r.body, kind: r.kind, createdAt: asIso(r.created_at), title: r.title ?? 'Conversation' })));
  } catch (err) { next(err); }
});

router.post('/messages/:id/star', requireUser, async (req, res, next) => {
  try {
    const member = await query(
      'SELECT 1 FROM messages msg JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id WHERE msg.id = $1 AND cm.user_id = $2',
      [req.params.id, req.user.id],
    );
    if (!member.rowCount) return res.status(404).json({ message: 'Message not found' });
    await query('INSERT INTO message_stars (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    res.json({ ok: true, starred: true });
  } catch (err) { next(err); }
});

router.delete('/messages/:id/star', requireUser, async (req, res, next) => {
  try {
    await query('DELETE FROM message_stars WHERE message_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true, starred: false });
  } catch (err) { next(err); }
});

// ================= CALLS =================

router.get('/calls', requireUser, async (req, res, next) => {
  try {
    const me = req.user.id;
    const { rows } = await query(
      `SELECT c.id, c.kind, c.is_group, c.status, c.started_at, c.ended_at, c.room_code,
              c.created_by,
              (SELECT count(*) FROM call_participants cp2 WHERE cp2.call_id = c.id)::int AS participants
         FROM calls c
         JOIN call_participants cp ON cp.call_id = c.id AND cp.user_id = $1
        ORDER BY c.started_at DESC LIMIT 50`,
      [me],
    );
    res.json(rows.map((r) => ({
      id: r.id, kind: r.kind, isGroup: Boolean(r.is_group), status: r.status,
      startedAt: asIso(r.started_at), endedAt: asIso(r.ended_at),
      durationSec: r.ended_at ? Math.max(0, Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000)) : null,
      direction: r.created_by === me ? 'outgoing' : 'incoming',
      participants: Number(r.participants) || 1,
      roomCode: r.room_code,
    })));
  } catch (err) { next(err); }
});

// ================= STORY DETAIL =================

router.get('/stories/:id', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.author_id, s.media_url, s.media_kind, s.text_body, s.background, s.created_at, s.expires_at,
              pr.username, pr.display_name, pr.avatar_color, pr.is_verified
         FROM stories s JOIN profiles pr ON pr.user_id = s.author_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [req.params.id],
    );
    if (!rows.length) return res.status(404).json({ message: 'That story has expired.' });
    const r = rows[0];
    const views = await query('SELECT count(*)::int AS n FROM story_views WHERE story_id = $1', [req.params.id]);
    res.json({
      id: r.id, authorId: r.author_id, username: r.username, displayName: r.display_name,
      avatarColor: r.avatar_color, verified: Boolean(r.is_verified),
      mediaUrl: r.media_url, mediaKind: r.media_kind, textBody: r.text_body, background: r.background,
      createdAt: asIso(r.created_at), expiresAt: asIso(r.expires_at),
      views: views.rows[0].n, mine: r.author_id === req.user.id,
    });
  } catch (err) { next(err); }
});

// ================= SOCIAL SAFETY (block / mute / restrict) =================

function socialList(table, idCol) {
  return async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT pr.user_id, pr.username, pr.display_name, pr.avatar_color, pr.is_verified
           FROM ${table} x JOIN profiles pr ON pr.user_id = x.${idCol}
          WHERE x.user_id = $1 ORDER BY x.created_at DESC LIMIT 200`,
        [req.user.id],
      );
      res.json(rows.map((r) => ({ id: r.user_id, username: r.username, displayName: r.display_name, avatarColor: r.avatar_color, verified: Boolean(r.is_verified) })));
    } catch (err) { next(err); }
  };
}

router.get('/blocked', requireUser, socialList('blocks', 'blocked_id'));
router.get('/muted', requireUser, socialList('mutes', 'muted_id'));
router.get('/restricted', requireUser, socialList('restrictions', 'restricted_id'));

function socialToggle(table, other, col) {
  return async (req, res, next) => {
    try {
      const off = ['false', '0', 'off'].includes(String(req.body?.enabled).toLowerCase());
      const target = String(req.params.userId);
      if (off) {
        await query(`DELETE FROM ${table} WHERE user_id = $1 AND ${col} = $2`, [req.user.id, target]);
      } else {
        if (target === req.user.id) return res.status(400).json({ message: 'Cannot target yourself.' });
        await query(`INSERT INTO ${table} (user_id, ${col}) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.user.id, target]);
      }
      res.json({ ok: true, enabled: !off });
    } catch (err) { next(err); }
  };
}

router.post('/blocked/:userId', requireUser, socialToggle('blocks', 'blocked_id', 'blocked_id'));
router.post('/muted/:userId', requireUser, socialToggle('mutes', 'muted_id', 'muted_id'));
router.post('/restricted/:userId', requireUser, socialToggle('restrictions', 'restricted_id', 'restricted_id'));

// ================= ACCOUNT LIFECYCLE =================

router.post('/account/deactivate', requireUser, async (req, res, next) => {
  try {
    await query('UPDATE profiles SET deactivated_at = now(), updated_at = now() WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/account/delete', requireUser, async (req, res, next) => {
  try {
    if (req.body?.confirm !== 'DELETE') return res.status(400).json({ message: 'Type DELETE to confirm.' });
    const me = req.user.id;
    // Mirror the web client: remove profile + auth rows. Profile delete cascades where FKs allow.
    await query('DELETE FROM profiles WHERE user_id = $1', [me]).catch(() => {});
    await query('DELETE FROM session WHERE "userId" = $1', [me]).catch(() => {});
    await query('DELETE FROM account WHERE "userId" = $1', [me]).catch(() => {});
    await query('DELETE FROM "user" WHERE id = $1', [me]).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= REPORTS =================

router.post('/reports', requireUser, async (req, res, next) => {
  try {
    const targetKind = ['post', 'comment', 'user', 'message', 'story'].includes(req.body?.targetKind) ? req.body.targetKind : 'post';
    const targetId = String(req.body?.targetId ?? '').slice(0, 80);
    const category = String(req.body?.category ?? 'other').slice(0, 40);
    const details = String(req.body?.details ?? '').slice(0, 500);
    if (!targetId) return res.status(400).json({ message: 'Nothing to report.' });
    const id = rid();
    await query(
      `INSERT INTO reports (id, reporter_id, target_kind, target_id, category, details, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open', now())`,
      [id, req.user.id, targetKind, targetId, category, details],
    );
    res.status(201).json({ ok: true, id });
  } catch (err) { next(err); }
});

export default router;
