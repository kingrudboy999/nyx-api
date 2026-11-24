import { Router } from 'express';
import { query, avatarColor, pool } from '../db.js';
import { requireUser } from '../auth.js';

const router = Router();
const PAGE = 20;

const FEED_TABS = new Set(['foryou', 'following', 'friends', 'trending']);

const asIso = (v) => (v instanceof Date ? v.toISOString() : String(v));

export async function readFeed(tab, meId, cursor, filters = {}) {
  const params = [meId];
  let filter = '';
  if (tab === 'following') {
    params.push(meId);
    filter = `AND p.author_id IN (SELECT following_id FROM follows WHERE follower_id = $${params.length})`;
  } else if (tab === 'friends') {
    params.push(meId);
    filter = `AND p.author_id IN (
      SELECT following_id FROM follows WHERE follower_id = $${params.length}
      INTERSECT SELECT follower_id FROM follows WHERE following_id = $${params.length})`;
  }
  if (filters.authorId) { params.push(filters.authorId); filter += ` AND p.author_id = $${params.length}`; }
  if (filters.tag) { params.push(filters.tag); filter += ` AND p.id IN (SELECT post_id FROM post_hashtags WHERE tag = $${params.length})`; }
  if (filters.media) { params.push(filters.media); filter += ` AND EXISTS (SELECT 1 FROM post_media pm2 WHERE pm2.post_id = p.id AND pm2.kind = $${params.length})`; }
  if (filters.bookmarkedBy) { params.push(filters.bookmarkedBy); filter += ` AND p.id IN (SELECT post_id FROM bookmarks WHERE user_id = $${params.length})`; }
  if (cursor) { params.push(cursor); filter += ` AND p.created_at < $${params.length}::timestamptz`; }
  const boost = `(p.boosted_until IS NOT NULL AND p.boosted_until > now()) DESC`;
  const order = tab === 'trending'
    ? `${boost}, (SELECT count(*) FROM post_likes pl WHERE pl.post_id = p.id) DESC, p.created_at DESC`
    : `${boost}, p.created_at DESC`;

  const { rows } = await query(
    `SELECT p.id, p.body, p.created_at, p.edited_at,
            pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified,
            (SELECT count(*) FROM post_likes pl WHERE pl.post_id = p.id) AS likes,
            (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.is_removed = false) AS comments,
            (SELECT count(*) FROM posts r WHERE r.repost_of_id = p.id) AS reposts,
            coalesce(p.view_count, 0) AS views,
            EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $1) AS liked,
            (SELECT kind FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.sort_order, pm.id LIMIT 1) AS media_kind
       FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
      WHERE p.is_removed = false ${filter}
      ORDER BY ${order}
      LIMIT ${PAGE + 1}`,
    params,
  );

  const items = rows.slice(0, PAGE).map((r) => ({
    id: r.id,
    author: {
      username: r.username, displayName: r.display_name,
      avatarColor: avatarColor(r.author_id), verified: r.is_verified,
    },
    createdAt: asIso(r.created_at),
    body: r.body,
    media: r.media_kind === 'video' ? 'video' : r.media_kind === 'image' ? 'image' : undefined,
    likes: Number(r.likes), comments: Number(r.comments), reposts: Number(r.reposts),
    views: Number(r.views), liked: Boolean(r.liked),
  }));
  const nextCursor = rows.length > PAGE ? items[items.length - 1].createdAt : null;
  return { items, nextCursor };
}

// ---------- parity routes ----------

router.get('/me', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*,
              (SELECT count(*) FROM follows WHERE following_id = p.user_id) AS followers,
              (SELECT count(*) FROM follows WHERE follower_id = p.user_id) AS following,
              coalesce((SELECT balance FROM coin_wallets WHERE user_id = p.user_id), 0) AS coins,
              EXISTS (SELECT 1 FROM user_interests WHERE user_id = p.user_id) AS interests_set,
              EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = p.user_id AND e.kind = 'nyxai_plus' AND e.status IN ('trial','active','grace')) AS is_premium
         FROM profiles p WHERE p.user_id = $1`,
      [req.user.id],
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ message: 'Profile not found' });
    res.json({
      id: p.user_id,
      username: p.username,
      displayName: p.display_name,
      avatarColor: avatarColor(p.user_id),
      bio: p.bio ?? '',
      onboarded: Boolean(p.onboarded),
      interestsSet: Boolean(p.interests_set),
      verifyKind: p.is_verified ? 'blue' : 'none',
      role: p.role,
      isPremium: Boolean(p.is_premium),
      isArc: false,
      isBanned: Boolean(p.is_banned),
      isSuspended: Boolean(p.is_suspended),
      deactivatedAt: null,
      followers: Number(p.followers),
      following: Number(p.following),
      coins: Number(p.coins),
    });
  } catch (err) { next(err); }
});

router.get('/feed', requireUser, async (req, res, next) => {
  try {
    const tab = FEED_TABS.has(String(req.query.tab ?? 'foryou')) ? String(req.query.tab ?? 'foryou') : 'foryou';
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : null;
    const filters = {};
    if (typeof req.query.author === 'string' && req.query.author.trim()) {
      const row = await query('SELECT user_id FROM profiles WHERE username_lc = $1', [req.query.author.trim().toLowerCase()]);
      if (!row.rowCount) return res.json({ items: [], nextCursor: null });
      filters.authorId = row.rows[0].user_id;
    }
    if (typeof req.query.tag === 'string' && req.query.tag.trim()) filters.tag = req.query.tag.trim().replace(/^#/, '').toLowerCase();
    if (req.query.media === 'video' || req.query.media === 'image') filters.media = req.query.media;
    res.json(await readFeed(tab, req.user.id, cursor, filters));
  } catch (err) { next(err); }
});

router.get('/stories', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT DISTINCT ON (s.author_id) s.id, s.created_at,
              pr.user_id AS author_id, pr.username, pr.display_name,
              EXISTS (SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.user_id = $1) AS seen
         FROM stories s JOIN profiles pr ON pr.user_id = s.author_id
        WHERE s.expires_at > now()
        ORDER BY s.author_id, s.created_at DESC`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.id, username: r.username, displayName: r.display_name,
      avatarColor: avatarColor(r.author_id), seen: Boolean(r.seen),
    })));
  } catch (err) { next(err); }
});

router.get('/trending-tags', requireUser, async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT tag FROM hashtags ORDER BY use_count DESC, updated_at DESC LIMIT 8');
    res.json(rows.map((r) => (r.tag.startsWith('#') ? r.tag : `#${r.tag}`)));
  } catch (err) { next(err); }
});

router.get('/live', requireUser, async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.id, l.title, l.viewer_peak, l.started_at, pr.user_id AS host_id, pr.display_name, pr.username
         FROM live_streams l JOIN profiles pr ON pr.user_id = l.host_id
        WHERE l.status = 'live'
        ORDER BY l.started_at DESC LIMIT 20`,
    );
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
    res.json(rows.map((r) => ({
      id: r.id, title: r.title, host: r.display_name,
      avatarColor: avatarColor(r.host_id), viewers: fmt(Number(r.viewer_peak) || 0),
      live: true, tag: 'live',
    })));
  } catch (err) { next(err); }
});

router.get('/inbox/unread', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT count(DISTINCT m.conversation_id) AS unread
         FROM conversation_members m
         JOIN messages msg ON msg.conversation_id = m.conversation_id
        WHERE m.user_id = $1 AND m.archived = false
          AND msg.sender_id <> $1
          AND msg.deleted_at IS NULL
          AND msg.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)`,
      [req.user.id],
    );
    res.json({ unread: Number(rows[0]?.unread ?? 0) });
  } catch (err) { next(err); }
});

router.get('/alerts/unread', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT count(*) AS unread FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.id],
    );
    res.json({ unread: Number(rows[0]?.unread ?? 0) });
  } catch (err) { next(err); }
});

router.post('/interests', requireUser, async (req, res, next) => {
  try {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t) => String(t).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_]/g, '').slice(0, 40)).filter(Boolean).slice(0, 32) : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_interests WHERE user_id = $1', [req.user.id]);
      for (const tag of new Set(tags)) {
        await client.query('INSERT INTO user_interests (user_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, tag]);
      }
      await client.query('UPDATE profiles SET onboarded = true, updated_at = now() WHERE user_id = $1', [req.user.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, tags });
  } catch (err) { next(err); }
});

export default router;
