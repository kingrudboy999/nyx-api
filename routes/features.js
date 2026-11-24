/**
 * NYX feature parity — everything the RN client does beyond the core read
 * routes, backed by the real Postgres schema. All routes require auth.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool, query, avatarColor } from '../db.js';
import { requireUser } from '../auth.js';
import { readFeed } from './api.js';

const router = Router();
const rid = () => randomUUID();
const asIso = (v) => (v instanceof Date ? v.toISOString() : String(v));
const PALETTE_TAG = (s) => avatarColor(String(s));

const fmtK = (n) => {
  n = Number(n) || 0;
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
};

const mapPostAuthor = (r) => ({
  username: r.username, displayName: r.display_name,
  avatarColor: avatarColor(r.author_id), verified: Boolean(r.is_verified),
});

async function postById(id, meId) {
  const { rows } = await query(
    `SELECT p.id, p.body, p.created_at, p.view_count, p.is_removed,
            pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified,
            (SELECT count(*) FROM post_likes pl WHERE pl.post_id = p.id) AS likes,
            (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.is_removed = false) AS comments,
            (SELECT count(*) FROM posts r WHERE r.repost_of_id = p.id) AS reposts,
            EXISTS (SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = $2) AS liked,
            (SELECT kind FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.sort_order, pm.id LIMIT 1) AS media_kind,
            (SELECT url FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.sort_order, pm.id LIMIT 1) AS media_url
       FROM posts p JOIN profiles pr ON pr.user_id = p.author_id
      WHERE p.id = $1`,
    [id, meId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, body: r.body, createdAt: asIso(r.created_at),
    author: mapPostAuthor(r),
    likes: Number(r.likes), comments: Number(r.comments), reposts: Number(r.reposts),
    views: Number(r.view_count) || 0, liked: Boolean(r.liked),
    media: r.media_kind === 'video' ? 'video' : r.media_kind === 'image' ? 'image' : undefined,
    mediaUrl: r.media_url ?? undefined,
  };
}

const mapComment = (r) => ({
  id: r.id, body: r.body, createdAt: asIso(r.created_at),
  author: mapPostAuthor(r),
});

// ================= POSTS =================

router.post('/posts', requireUser, async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ message: 'Say something first.' });
    if (body.length > 2800) return res.status(400).json({ message: 'Post is too long (max 2800).' });
    const kind = req.body?.kind === 'video' ? 'video' : 'post';
    const location = req.body?.location ? String(req.body.location).trim().slice(0, 120) : null;
    const id = rid();
    await query(
      `INSERT INTO posts (id, author_id, body, kind, location, created_at, updated_at, published_at)
       VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [id, req.user.id, body, kind, location],
    );
    const tags = [...new Set([...body.matchAll(/#([a-zA-Z0-9_]{2,40})/g)].map((m) => m[1].toLowerCase()))];
    for (const tag of tags) {
      await query('INSERT INTO post_hashtags (post_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, tag]);
      await query(
        `INSERT INTO hashtags (tag, use_count, updated_at) VALUES ($1, 1, now())
         ON CONFLICT (tag) DO UPDATE SET use_count = hashtags.use_count + 1, updated_at = now()`,
        [tag],
      );
    }
    res.status(201).json(await postById(id, req.user.id));
  } catch (err) { next(err); }
});

router.get('/posts/:id', requireUser, async (req, res, next) => {
  try {
    const post = await postById(req.params.id, req.user.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    res.json(post);
  } catch (err) { next(err); }
});

router.delete('/posts/:id', requireUser, async (req, res, next) => {
  try {
    const { rowCount } = await query(
      'UPDATE posts SET is_removed = true, updated_at = now() WHERE id = $1 AND author_id = $2',
      [req.params.id, req.user.id],
    );
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

router.post('/posts/:id/view', requireUser, async (req, res, next) => {
  try {
    const ins = await query('INSERT INTO post_views (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    if (ins.rowCount) await query('UPDATE posts SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/posts/:id/like', requireUser, async (req, res, next) => {
  try {
    const del = await query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const liked = del.rowCount === 0;
    if (liked) await query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    const { rows } = await query('SELECT count(*) AS n FROM post_likes WHERE post_id = $1', [req.params.id]);
    res.json({ liked, likes: Number(rows[0].n) });
  } catch (err) { next(err); }
});

router.post('/posts/:id/repost', requireUser, async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM posts WHERE author_id = $1 AND repost_of_id = $2', [req.user.id, req.params.id]);
    let reposted = false;
    if (existing.rowCount) {
      await query('DELETE FROM posts WHERE id = $1', [existing.rows[0].id]);
    } else {
      await query(
        `INSERT INTO posts (id, author_id, body, kind, repost_of_id, created_at, updated_at, published_at)
         VALUES ($1, $2, '', 'repost', $3, now(), now(), now())`,
        [rid(), req.user.id, req.params.id],
      );
      reposted = true;
    }
    const { rows } = await query("SELECT count(*) AS n FROM posts WHERE repost_of_id = $1 AND is_removed = false", [req.params.id]);
    res.json({ reposted, reposts: Number(rows[0].n) });
  } catch (err) { next(err); }
});

router.post('/posts/:id/bookmark', requireUser, async (req, res, next) => {
  try {
    const del = await query('DELETE FROM bookmarks WHERE user_id = $1 AND post_id = $2', [req.user.id, req.params.id]);
    const saved = del.rowCount === 0;
    if (saved) await query('INSERT INTO bookmarks (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
    res.json({ saved });
  } catch (err) { next(err); }
});

router.get('/posts/:id/comments', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.body, c.created_at, pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified
         FROM comments c JOIN profiles pr ON pr.user_id = c.author_id
        WHERE c.post_id = $1 AND c.is_removed = false
        ORDER BY c.created_at ASC LIMIT 100`,
      [req.params.id],
    );
    res.json(rows.map(mapComment));
  } catch (err) { next(err); }
});

router.post('/posts/:id/comments', requireUser, async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ message: 'Comment cannot be empty.' });
    const id = rid();
    await query(
      'INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES ($1, $2, $3, $4, now())',
      [id, req.params.id, req.user.id, body.slice(0, 1400)],
    );
    const { rows } = await query(
      `SELECT c.id, c.body, c.created_at, pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified
         FROM comments c JOIN profiles pr ON pr.user_id = c.author_id WHERE c.id = $1`,
      [id],
    );
    res.status(201).json(mapComment(rows[0]));
  } catch (err) { next(err); }
});

// ================= PROFILES / SOCIAL =================

router.get('/u/:username', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, (SELECT count(*) FROM follows WHERE following_id = p.user_id) AS followers,
              (SELECT count(*) FROM follows WHERE follower_id = p.user_id) AS following,
              (SELECT count(*) FROM posts WHERE author_id = p.user_id AND is_removed = false) AS posts,
              EXISTS (SELECT 1 FROM follows WHERE follower_id = $2 AND following_id = p.user_id) AS you_follow
         FROM profiles p WHERE p.username_lc = $1`,
      [String(req.params.username).toLowerCase(), req.user.id],
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ message: 'User not found' });
    res.json({
      id: p.user_id, username: p.username, displayName: p.display_name,
      avatarColor: avatarColor(p.user_id), bio: p.bio ?? '',
      verifyKind: p.is_verified ? 'blue' : 'none', role: p.role,
      isPrivate: Boolean(p.is_private),
      followers: Number(p.followers), following: Number(p.following), posts: Number(p.posts),
      youFollow: Boolean(p.you_follow), isMe: p.user_id === req.user.id,
    });
  } catch (err) { next(err); }
});

router.post('/u/:username/follow', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT user_id FROM profiles WHERE username_lc = $1', [String(req.params.username).toLowerCase()]);
    const target = rows[0]?.user_id;
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target === req.user.id) return res.status(400).json({ message: 'You cannot follow yourself.' });
    const del = await query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [req.user.id, target]);
    const following = del.rowCount === 0;
    if (following) await query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, target]);
    const count = await query('SELECT count(*) AS n FROM follows WHERE following_id = $1', [target]);
    res.json({ following, followers: Number(count.rows[0].n) });
  } catch (err) { next(err); }
});

router.get('/discover/suggested', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT pr.user_id, pr.username, pr.display_name, pr.is_verified,
              (SELECT count(*) FROM follows f WHERE f.following_id = pr.user_id) AS followers
         FROM profiles pr
        WHERE pr.user_id <> $1 AND pr.is_banned = false
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = pr.user_id)
        ORDER BY followers DESC, pr.created_at ASC
        LIMIT 12`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.user_id, username: r.username, displayName: r.display_name,
      avatarColor: avatarColor(r.user_id), verified: Boolean(r.is_verified),
      note: `${fmtK(r.followers)} followers`,
    })));
  } catch (err) { next(err); }
});

router.get('/friends', requireUser, async (req, res, next) => {
  try {
    const friends = await query(
      `SELECT pr.user_id, pr.username, pr.display_name, pr.is_verified, pr.show_online, pr.last_seen_at
         FROM profiles pr
        WHERE pr.user_id <> $1
          AND pr.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
          AND pr.user_id IN (SELECT follower_id FROM follows WHERE following_id = $1)
        ORDER BY pr.display_name LIMIT 100`,
      [req.user.id],
    );
    const incoming = await query(
      `SELECT fr.id, fr.from_id, pr.username, pr.display_name, pr.is_verified, fr.created_at
         FROM friend_requests fr JOIN profiles pr ON pr.user_id = fr.from_id
        WHERE fr.to_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC LIMIT 50`,
      [req.user.id],
    );
    res.json({
      friends: friends.rows.map((r) => ({
        id: r.user_id, username: r.username, displayName: r.display_name,
        avatarColor: avatarColor(r.user_id), verified: Boolean(r.is_verified),
        online: Boolean(r.show_online) && r.last_seen_at && (Date.now() - new Date(r.last_seen_at).getTime()) < 5 * 60_000,
      })),
      incoming: incoming.rows.map((r) => ({
        id: r.id, username: r.username, displayName: r.display_name,
        avatarColor: avatarColor(r.from_id), verified: Boolean(r.is_verified),
        createdAt: asIso(r.created_at),
      })),
    });
  } catch (err) { next(err); }
});

router.post('/friends/requests/:id/:action', requireUser, async (req, res, next) => {
  try {
    const action = req.params.action;
    if (!['accept', 'decline'].includes(action)) return res.status(400).json({ message: 'Unknown action' });
    const { rows } = await query("SELECT id, from_id, to_id FROM friend_requests WHERE id = $1 AND to_id = $2 AND status = 'pending'", [req.params.id, req.user.id]);
    const reqRow = rows[0];
    if (!reqRow) return res.status(404).json({ message: 'Request not found' });
    if (action === 'accept') {
      await query("UPDATE friend_requests SET status = 'accepted', updated_at = now() WHERE id = $1", [req.params.id]);
      const [a, b] = [reqRow.from_id, req.user.id].sort();
      await query('INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a, b]);
    } else {
      await query("UPDATE friend_requests SET status = 'declined', updated_at = now() WHERE id = $1", [req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/saved', requireUser, async (req, res, next) => {
  try {
    res.json(await readFeed('foryou', req.user.id, null, { bookmarkedBy: req.user.id }));
  } catch (err) { next(err); }
});

router.get('/memories', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, media_url, media_kind, caption, created_at FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40',
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.id, title: r.caption || 'Memory', date: asIso(r.created_at),
      mediaKind: r.media_kind, mediaUrl: r.media_url ?? null,
    })));
  } catch (err) { next(err); }
});

router.post('/stories', requireUser, async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? '').trim().slice(0, 500);
    const mediaUrl = req.body?.mediaUrl ? String(req.body.mediaUrl).slice(0, 1500000) : null;
    const mediaKind = mediaUrl ? (req.body?.mediaKind === 'video' ? 'video' : 'image') : 'text';
    if (!text && !mediaUrl) return res.status(400).json({ message: 'A story needs text or media.' });
    const id = rid();
    await query(
      `INSERT INTO stories (id, author_id, media_url, media_kind, text_body, background, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '24 hours', now())`,
      [id, req.user.id, mediaUrl, mediaKind, text || null, '#07090f'],
    );
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.post('/stories/:id/view', requireUser, async (req, res, next) => {
  try {
    await query('INSERT INTO story_views (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= INBOX / MESSAGES =================

router.get('/inbox/threads', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.kind, c.title, c.last_message_at, c.last_message_body, m.pinned, m.favorite, m.marked_unread,
              (SELECT count(*) FROM messages msg
                WHERE msg.conversation_id = c.id AND msg.sender_id <> $1 AND msg.deleted_at IS NULL
                  AND msg.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)) AS unread,
              CASE WHEN c.kind = 'dm' THEN (
                SELECT coalesce(p2.display_name, 'Conversation') FROM conversation_members cm2
                JOIN profiles p2 ON p2.user_id = cm2.user_id
                WHERE cm2.conversation_id = c.id AND cm2.user_id <> $1 LIMIT 1)
              ELSE coalesce(c.title, 'Group') END AS name,
              CASE WHEN c.kind = 'dm' THEN (
                SELECT cm2.user_id FROM conversation_members cm2
                WHERE cm2.conversation_id = c.id AND cm2.user_id <> $1 LIMIT 1)
              ELSE NULL END AS other_id,
              CASE WHEN c.kind = 'dm' THEN (
                SELECT (p2.show_online AND p2.last_seen_at > now() - interval '5 minutes')
                  FROM conversation_members cm2 JOIN profiles p2 ON p2.user_id = cm2.user_id
                 WHERE cm2.conversation_id = c.id AND cm2.user_id <> $1 LIMIT 1)
              ELSE false END AS online
         FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1
        WHERE m.archived = $2
        ORDER BY m.pinned DESC, coalesce(c.last_message_at, c.created_at) DESC
        LIMIT 50`,
      [req.user.id, req.query.archived === '1'],
    );
    res.json(rows.map((r) => ({
      id: r.id, name: r.name ?? 'Conversation',
      peerId: r.other_id ?? null,
      color: avatarColor(r.other_id ?? r.id),
      last: r.last_message_body ?? '',
      time: asIso(r.last_message_at ?? new Date()),
      unread: Number(r.unread) || 0,
      online: Boolean(r.online),
      kind: r.kind, pinned: Boolean(r.pinned), favorite: Boolean(r.favorite), markedUnread: Boolean(r.marked_unread),
    })));
  } catch (err) { next(err); }
});

router.get('/inbox/threads/:id/members', requireUser, async (req, res, next) => {
  try {
    const member = await query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND banned_at IS NULL', [req.params.id, req.user.id]);
    if (!member.rowCount) return res.status(404).json({ message: 'Conversation not found' });
    const { rows } = await query(
      `SELECT cm.user_id AS id, pr.username, pr.display_name, pr.avatar_color, cm.role
         FROM conversation_members cm JOIN profiles pr ON pr.user_id = cm.user_id
        WHERE cm.conversation_id = $1 AND cm.banned_at IS NULL
        ORDER BY cm.joined_at ASC LIMIT 200`,
      [req.params.id],
    );
    res.json(rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, avatarColor: r.avatar_color, role: r.role })));
  } catch (err) { next(err); }
});

router.get('/inbox/threads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const member = await query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!member.rowCount) return res.status(404).json({ message: 'Conversation not found' });
    const { rows } = await query(
      `SELECT id, sender_id, kind, body, media_url, reply_to_id, edited_at, created_at
         FROM messages WHERE conversation_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 200`,
      [req.params.id],
    );
    const ids = rows.map((r) => r.id);
    let reactions = [], opens = [];
    if (ids.length) {
      reactions = (await query(
        `SELECT message_id, emoji, count(*)::int AS n, bool_or(user_id = $2) AS mine
           FROM message_reactions WHERE message_id = ANY($1) GROUP BY message_id, emoji`,
        [ids, req.user.id],
      )).rows;
      opens = (await query(
        `SELECT message_id, count(*)::int AS n, bool_or(user_id = $2) AS mine
           FROM view_once_opens WHERE message_id = ANY($1) GROUP BY message_id`,
        [ids, req.user.id],
      )).rows;
    }
    const byMsg = new Map(), openByMsg = new Map();
    for (const r of reactions) {
      const arr = byMsg.get(r.message_id) ?? [];
      arr.push({ emoji: r.emoji, count: r.n, mine: r.mine });
      byMsg.set(r.message_id, arr);
    }
    for (const o of opens) openByMsg.set(o.message_id, { total: o.n, mine: Boolean(o.mine) });
    res.json(rows.map((r) => {
      const isVO = String(r.kind).startsWith('view_once_');
      const o = openByMsg.get(r.id);
      return {
        id: r.id, from: r.sender_id === req.user.id ? 'me' : 'them',
        text: r.body, kind: r.kind, time: asIso(r.created_at),
        mediaUrl: isVO ? null : (r.media_url ?? null),
        replyToId: r.reply_to_id ?? null,
        editedAt: r.edited_at ? asIso(r.edited_at) : null,
        reactions: byMsg.get(r.id) ?? [],
        ...(isVO ? { viewOnce: { openedTotal: o?.total ?? 0, openedByMe: Boolean(o?.mine) } } : {}),
      };
    }));
  } catch (err) { next(err); }
});

router.post('/inbox/threads/:id/messages', requireUser, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const kind = ['text', 'image', 'view_once_photo', 'view_once_video'].includes(String(body.kind)) ? String(body.kind) : 'text';
    const text = String(body.text ?? '').trim().slice(0, 4000);
    const mediaUrl = body.mediaUrl ? String(body.mediaUrl).slice(0, 1500000) : null;
    const replyToId = body.replyToId ? String(body.replyToId).slice(0, 64) : null;
    if (!text && !mediaUrl) return res.status(400).json({ message: 'Message cannot be empty.' });
    if (kind !== 'text' && !mediaUrl) return res.status(400).json({ message: 'Attach media first.' });
    const member = await query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND banned_at IS NULL', [req.params.id, req.user.id]);
    if (!member.rowCount) return res.status(404).json({ message: 'Conversation not found' });
    const bc = await query('SELECT is_broadcast FROM conversations WHERE id = $1', [req.params.id]);
    if (bc.rows[0]?.is_broadcast && !['owner', 'admin'].includes(member.rows[0].role)) {
      return res.status(403).json({ message: 'Only the channel owner can post.' });
    }
    const id = rid();
    await query(
      'INSERT INTO messages (id, conversation_id, sender_id, kind, body, media_url, reply_to_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())',
      [id, req.params.id, req.user.id, kind, text, mediaUrl, replyToId],
    );
    const preview = text || (kind === 'view_once_video' ? 'View-once video' : kind === 'view_once_photo' ? 'View-once photo' : 'Photo');
    await query('UPDATE conversations SET last_message_at = now(), last_message_body = $2 WHERE id = $1', [req.params.id, preview.slice(0, 120)]);
    const isVO = kind.startsWith('view_once_');
    res.status(201).json({ id, from: 'me', text, kind, time: new Date().toISOString(), mediaUrl: isVO ? null : mediaUrl, replyToId, reactions: [], ...(isVO ? { viewOnce: { openedTotal: 0, openedByMe: false } } : {}) });
  } catch (err) { next(err); }
});

router.post('/inbox/threads/:id/read', requireUser, async (req, res, next) => {
  try {
    await query('UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= ALERTS / NOTIFICATIONS =================

router.get('/alerts', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, kind, body, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id],
    );
    res.json(rows.map((r) => ({ id: r.id, kind: r.kind, text: r.body, time: asIso(r.created_at), read: Boolean(r.is_read) })));
  } catch (err) { next(err); }
});

router.post('/alerts/read-all', requireUser, async (req, res, next) => {
  try {
    await query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ================= COINS =================

router.get('/coins', requireUser, async (req, res, next) => {
  try {
    const wallet = await query('SELECT balance FROM coin_wallets WHERE user_id = $1', [req.user.id]);
    const lifetime = await query("SELECT coalesce(sum(amount), 0) AS n FROM coin_ledger WHERE user_id = $1 AND direction = 'in'", [req.user.id]);
    const streak = await query('SELECT coalesce(max(count), 0) AS n FROM streaks WHERE user_a = $1 OR user_b = $1', [req.user.id]);
    const ledger = await query(
      'SELECT id, kind, direction, amount, reason, created_at FROM coin_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15',
      [req.user.id],
    );
    res.json({
      balance: Number(wallet.rows[0]?.balance ?? 0),
      lifetime: Number(lifetime.rows[0].n),
      streak: Number(streak.rows[0].n),
      nextReward: null,
      ledger: ledger.rows.map((r) => ({
        id: r.id, kind: r.kind, direction: r.direction, amount: Number(r.amount),
        reason: r.reason ?? null, createdAt: asIso(r.created_at),
      })),
    });
  } catch (err) { next(err); }
});

// ================= COMMUNITIES (Spaces) =================

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'space';
const mapCommunity = (r, joined) => ({
  id: r.id, name: r.name, slug: r.slug,
  description: r.description ?? '', tag: r.category ?? '',
  memberCount: Number(r.member_count) || 0,
  members: fmtK(r.member_count),
  color: PALETTE_TAG(r.slug),
  kind: r.kind,
  joined: joined ?? null,
});

router.get('/communities', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = $1) AS joined
         FROM communities c WHERE c.kind = 'community' AND c.is_private = false AND c.access = 'public'
        ORDER BY c.member_count DESC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map((r) => mapCommunity(r, Boolean(r.joined))));
  } catch (err) { next(err); }
});

router.post('/communities', requireUser, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    const description = String(req.body?.description ?? '').trim().slice(0, 500);
    const category = String(req.body?.category ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
    if (name.length < 3) return res.status(400).json({ message: 'Name must be at least 3 characters.' });
    let slug = slugify(name);
    const clash = await query('SELECT 1 FROM communities WHERE slug = $1', [slug]);
    if (clash.rowCount) slug = `${slug}-${rid().slice(0, 4)}`;
    const id = rid();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO communities (id, kind, slug, name, description, category, about, created_by, member_count, created_at)
         VALUES ($1, 'community', $2, $3, $4, $5, $4, $6, 1, now())`,
        [id, slug, name, description, category, req.user.id],
      );
      await client.query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner')", [id, req.user.id]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
    const { rows } = await query('SELECT * FROM communities WHERE id = $1', [id]);
    res.status(201).json(mapCommunity(rows[0], true));
  } catch (err) { next(err); }
});

router.get('/communities/:id', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.*, EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = $1) AS joined
         FROM communities c WHERE c.id = $2 OR c.slug = $2`,
      [req.user.id, req.params.id],
    );
    const c = rows[0];
    if (!c) return res.status(404).json({ message: 'Community not found' });
    const rules = await query('SELECT id, title, body FROM community_rules WHERE community_id = $1 AND active = true ORDER BY sort_order, id', [c.id]);
    const posts = await query(
      `SELECT cp.id, cp.title, cp.body, cp.score, cp.upvotes, cp.downvotes, cp.pinned, cp.created_at,
              pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified,
              coalesce((SELECT value FROM community_votes v WHERE v.post_id = cp.id AND v.user_id = $1), 0) AS my_vote
         FROM community_posts cp JOIN profiles pr ON pr.user_id = cp.author_id
        WHERE cp.community_id = $2 AND cp.is_removed = false
        ORDER BY cp.pinned DESC, cp.score DESC, cp.created_at DESC LIMIT 25`,
      [req.user.id, c.id],
    );
    const membership = await query('SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2', [c.id, req.user.id]);
    res.json({
      ...mapCommunity(c, Boolean(c.joined)),
      myRole: membership.rows[0]?.role ?? null,
      about: c.about ?? '',
      rules: rules.rows.map((r) => ({ id: r.id, title: r.title, body: r.body })),
      posts: posts.rows.map((r) => ({
        id: r.id, title: r.title, body: r.body,
        score: Number(r.score), upvotes: Number(r.upvotes), myVote: Number(r.my_vote),
        pinned: Boolean(r.pinned), createdAt: asIso(r.created_at),
        author: mapPostAuthor(r),
      })),
    });
  } catch (err) { next(err); }
});

router.post('/communities/:id/join', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id FROM communities WHERE id = $1 OR slug = $1', [req.params.id]);
    const id = rows[0]?.id;
    if (!id) return res.status(404).json({ message: 'Community not found' });
    const del = await query('DELETE FROM community_members WHERE community_id = $1 AND user_id = $2', [id, req.user.id]);
    const joined = del.rowCount === 0;
    if (joined) await query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [id, req.user.id]);
    const count = await query('SELECT count(*) AS n FROM community_members WHERE community_id = $1', [id]);
    await query('UPDATE communities SET member_count = $2 WHERE id = $1', [id, Number(count.rows[0].n)]);
    res.json({ joined, memberCount: Number(count.rows[0].n) });
  } catch (err) { next(err); }
});

router.post('/communities/:id/rules', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id FROM communities c
        JOIN community_members m ON m.community_id = c.id AND m.user_id = $2
       WHERE (c.id = $1 OR c.slug = $1) AND m.role IN ('owner', 'admin', 'moderator')`,
      [req.params.id, req.user.id],
    );
    const id = rows[0]?.id;
    if (!id) return res.status(403).json({ message: 'Only moderators can add rules.' });
    const title = String(req.body?.title ?? '').trim().slice(0, 80);
    if (!title) return res.status(400).json({ message: 'Rule title required.' });
    const rid2 = rid();
    await query('INSERT INTO community_rules (id, community_id, title, body, sort_order) VALUES ($1, $2, $3, $4, 100)', [rid2, id, title, String(req.body?.body ?? '').slice(0, 500)]);
    res.status(201).json({ id: rid2, title });
  } catch (err) { next(err); }
});

router.post('/communities/:id/posts', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id FROM communities WHERE id = $1 OR slug = $1', [req.params.id]);
    const id = rows[0]?.id;
    if (!id) return res.status(404).json({ message: 'Community not found' });
    const member = await query('SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [id, req.user.id]);
    if (!member.rowCount) return res.status(403).json({ message: 'Join the community to post.' });
    const title = String(req.body?.title ?? '').trim().slice(0, 150);
    const body = String(req.body?.body ?? '').trim().slice(0, 4000);
    if (!title && !body) return res.status(400).json({ message: 'Write something first.' });
    const pid = rid();
    await query(
      'INSERT INTO community_posts (id, community_id, author_id, title, body, created_at) VALUES ($1, $2, $3, $4, $5, now())',
      [pid, id, req.user.id, title, body],
    );
    await query('UPDATE communities SET post_count = coalesce(post_count, 0) + 1 WHERE id = $1', [id]);
    res.status(201).json({ id: pid });
  } catch (err) { next(err); }
});

router.post('/communities/:id/posts/:pid/vote', requireUser, async (req, res, next) => {
  try {
    const community = await query('SELECT id FROM communities WHERE id = $1 OR slug = $1', [req.params.id]);
    const cid = community.rows[0]?.id;
    if (!cid) return res.status(404).json({ message: 'Community not found' });
    const value = Number(req.body?.value);
    if (![-1, 0, 1].includes(value)) return res.status(400).json({ message: 'value must be -1, 0 or 1' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (value === 0) {
        await client.query('DELETE FROM community_votes WHERE post_id = $1 AND user_id = $2', [req.params.pid, req.user.id]);
      } else {
        await client.query(
          `INSERT INTO community_votes (post_id, user_id, value) VALUES ($1, $2, $3)
           ON CONFLICT (post_id, user_id) DO UPDATE SET value = EXCLUDED.value`,
          [req.params.pid, req.user.id, value],
        );
      }
      const agg = await client.query(
        `SELECT coalesce(sum(case when value = 1 then 1 else 0 end), 0) AS up,
                coalesce(sum(case when value = -1 then 1 else 0 end), 0) AS down
           FROM community_votes WHERE post_id = $1`,
        [req.params.pid],
      );
      const up = Number(agg.rows[0].up), down = Number(agg.rows[0].down);
      await client.query('UPDATE community_posts SET upvotes = $2, downvotes = $3, score = $4 WHERE id = $1 AND community_id = $5',
        [req.params.pid, up, down, up - down, cid]);
      await client.query('COMMIT');
      const myVote = await query('SELECT value FROM community_votes WHERE post_id = $1 AND user_id = $2', [req.params.pid, req.user.id]);
      res.json({ upvotes: up, downvotes: down, score: up - down, myVote: myVote.rowCount ? Number(myVote.rows[0].value) : 0 });
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  } catch (err) { next(err); }
});

// ================= EVENTS =================

const mapEvent = (r, myRsvp) => ({
  id: r.id, title: r.title, description: r.description ?? '',
  location: r.location ?? (r.is_online ? 'Online' : ''),
  startsAt: asIso(r.starts_at), endsAt: r.ends_at ? asIso(r.ends_at) : null,
  online: Boolean(r.is_online), url: r.cover_url ?? null,
  going: Number(r.going) || 0, rsvp: myRsvp ?? null,
});

router.get('/events', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT e.*, (SELECT count(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'going') AS going,
              (SELECT status FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = $1) AS my_rsvp
         FROM nyx_events e
        WHERE e.starts_at > now() - interval '6 hours'
        ORDER BY e.starts_at ASC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map((r) => mapEvent(r, r.my_rsvp === 'going' ? 'going' : r.my_rsvp ?? null)));
  } catch (err) { next(err); }
});

router.post('/events', requireUser, async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim().slice(0, 120);
    const startsAt = new Date(req.body?.startsAt ?? '');
    if (title.length < 3) return res.status(400).json({ message: 'Event title required (min 3 chars).' });
    if (Number.isNaN(startsAt.getTime())) return res.status(400).json({ message: 'Valid start date/time required.' });
    const id = rid();
    await query(
      `INSERT INTO nyx_events (id, host_id, title, description, starts_at, location, is_online, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [id, req.user.id, title, String(req.body?.description ?? '').slice(0, 2000), startsAt,
       String(req.body?.location ?? '').slice(0, 160) || null, Boolean(req.body?.isOnline)],
    );
    await query("INSERT INTO event_rsvps (event_id, user_id, status) VALUES ($1, $2, 'going') ON CONFLICT DO NOTHING", [id, req.user.id]);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.post('/events/:id/rsvp', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id FROM nyx_events WHERE id = $1', [req.params.id]);
    if (!rows.rowCount) return res.status(404).json({ message: 'Event not found' });
    const del = await query("DELETE FROM event_rsvps WHERE event_id = $1 AND user_id = $2 AND status = 'going'", [req.params.id, req.user.id]);
    const going = del.rowCount === 0;
    if (going) {
      await query(
        `INSERT INTO event_rsvps (event_id, user_id, status) VALUES ($1, $2, 'going')
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'going'`,
        [req.params.id, req.user.id],
      );
    }
    const count = await query("SELECT count(*) AS n FROM event_rsvps WHERE event_id = $1 AND status = 'going'", [req.params.id]);
    res.json({ going, goingCount: Number(count.rows[0].n) });
  } catch (err) { next(err); }
});

// ================= CHALLENGES =================

router.get('/challenges', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.title, c.rules, c.hashtag, c.deadline, c.created_at,
              (SELECT count(*) FROM challenge_entries e WHERE e.challenge_id = c.id) AS entries,
              (SELECT count(*) FROM challenge_entries e WHERE e.challenge_id = c.id AND e.user_id = $1) AS my_entries
         FROM challenges c ORDER BY c.deadline NULLS LAST, c.created_at DESC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.id, title: r.title, rules: r.rules ?? '', hashtag: r.hashtag,
      deadline: r.deadline ? asIso(r.deadline) : null,
      entries: Number(r.entries), myEntries: Number(r.my_entries),
    })));
  } catch (err) { next(err); }
});

router.post('/challenges', requireUser, async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim().slice(0, 80);
    const hashtag = String(req.body?.hashtag ?? '').trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    if (title.length < 3 || !hashtag) return res.status(400).json({ message: 'Title (min 3) and hashtag required.' });
    const id = rid();
    await query(
      `INSERT INTO challenges (id, creator_id, title, rules, hashtag, deadline, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [id, req.user.id, title, String(req.body?.rules ?? '').slice(0, 1000), hashtag,
       req.body?.deadline ? new Date(req.body.deadline) : null],
    );
    res.status(201).json({ id, title, hashtag });
  } catch (err) { next(err); }
});

// ================= STICKERS =================

router.get('/stickers', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.title, p.author_name,
              EXISTS (SELECT 1 FROM user_sticker_packs u WHERE u.pack_id = p.id AND u.user_id = $1) AS installed,
              coalesce((SELECT json_agg(s.emoji ORDER BY s.sort_order) FROM stickers s WHERE s.pack_id = p.id), '[]'::json) AS emojis
         FROM sticker_packs p ORDER BY p.created_at ASC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map((r) => ({
      id: r.id, title: r.title, author: r.author_name,
      installed: Boolean(r.installed),
      stickers: Array.isArray(r.emojis) ? r.emojis : [],
    })));
  } catch (err) { next(err); }
});

router.post('/stickers/packs/:id/toggle', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id FROM sticker_packs WHERE id = $1', [req.params.id]);
    if (!rows.rowCount) return res.status(404).json({ message: 'Pack not found' });
    const del = await query('DELETE FROM user_sticker_packs WHERE user_id = $1 AND pack_id = $2', [req.user.id, req.params.id]);
    const installed = del.rowCount === 0;
    if (installed) await query('INSERT INTO user_sticker_packs (user_id, pack_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
    res.json({ installed });
  } catch (err) { next(err); }
});

// ================= LISTS =================

const mapList = (r) => ({
  id: r.id, name: r.name, description: r.description ?? '',
  members: Number(r.members) || 0,
  mine: Boolean(r.mine), following: Boolean(r.following),
  updatedHours: Math.max(0, Math.round((Date.now() - new Date(r.updated_at).getTime()) / 3_600_000)),
});

router.get('/lists', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, (SELECT count(*) FROM user_list_members m WHERE m.list_id = l.id) AS members,
              (l.owner_id = $1) AS mine,
              EXISTS (SELECT 1 FROM user_list_follows f WHERE f.list_id = l.id AND f.user_id = $1) AS following
         FROM user_lists l
        WHERE l.owner_id = $1 OR l.is_private = false
        ORDER BY mine DESC, l.updated_at DESC LIMIT 50`,
      [req.user.id],
    );
    res.json(rows.map(mapList));
  } catch (err) { next(err); }
});

router.post('/lists', requireUser, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ message: 'List name required (min 2 chars).' });
    const id = rid();
    await query(
      'INSERT INTO user_lists (id, owner_id, name, description, is_private, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, now(), now())',
      [id, req.user.id, name, String(req.body?.description ?? '').slice(0, 280), Boolean(req.body?.isPrivate)],
    );
    res.status(201).json({ id, name });
  } catch (err) { next(err); }
});

router.get('/lists/:id', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, (SELECT count(*) FROM user_list_members m WHERE m.list_id = l.id) AS members,
              (l.owner_id = $2) AS mine,
              EXISTS (SELECT 1 FROM user_list_follows f WHERE f.list_id = l.id AND f.user_id = $2) AS following
         FROM user_lists l WHERE l.id = $1 AND (l.is_private = false OR l.owner_id = $2)`,
      [req.params.id, req.user.id],
    );
    const l = rows[0];
    if (!l) return res.status(404).json({ message: 'List not found' });
    const members = await query(
      `SELECT pr.user_id, pr.username, pr.display_name, pr.is_verified
         FROM user_list_members m JOIN profiles pr ON pr.user_id = m.user_id
        WHERE m.list_id = $1 ORDER BY m.added_at DESC LIMIT 100`,
      [l.id],
    );
    res.json({
      ...mapList(l),
      members: Number(l.members) || 0,
      memberProfiles: members.rows.map((r) => ({
        id: r.user_id, username: r.username, displayName: r.display_name,
        avatarColor: avatarColor(r.user_id), verified: Boolean(r.is_verified),
      })),
    });
  } catch (err) { next(err); }
});

router.post('/lists/:id/follow', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, owner_id FROM user_lists WHERE id = $1 AND is_private = false', [req.params.id]);
    const l = rows[0];
    if (!l) return res.status(404).json({ message: 'List not found' });
    if (l.owner_id === req.user.id) return res.status(400).json({ message: 'You own this list.' });
    const del = await query('DELETE FROM user_list_follows WHERE list_id = $1 AND user_id = $2', [l.id, req.user.id]);
    const following = del.rowCount === 0;
    if (following) await query('INSERT INTO user_list_follows (list_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [l.id, req.user.id]);
    res.json({ following });
  } catch (err) { next(err); }
});

// ================= ME / SETTINGS =================

async function mePayload(userId) {
  const { rows } = await query(
    `SELECT p.*,
            (SELECT count(*) FROM follows WHERE following_id = p.user_id) AS followers,
            (SELECT count(*) FROM follows WHERE follower_id = p.user_id) AS following,
            coalesce((SELECT balance FROM coin_wallets WHERE user_id = p.user_id), 0) AS coins,
            EXISTS (SELECT 1 FROM user_interests WHERE user_id = p.user_id) AS interests_set,
            EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = p.user_id AND e.kind = 'nyxai_plus' AND e.status IN ('trial','active','grace')) AS is_premium
       FROM profiles p WHERE p.user_id = $1`,
    [userId],
  );
  const p = rows[0];
  if (!p) return null;
  return {
    id: p.user_id, username: p.username, displayName: p.display_name,
    avatarColor: avatarColor(p.user_id), bio: p.bio ?? '',
    onboarded: Boolean(p.onboarded), interestsSet: Boolean(p.interests_set),
    verifyKind: p.is_verified ? 'blue' : 'none', role: p.role,
    isPremium: Boolean(p.is_premium), isArc: false,
    isBanned: Boolean(p.is_banned), isSuspended: Boolean(p.is_suspended), deactivatedAt: null,
    followers: Number(p.followers), following: Number(p.following), coins: Number(p.coins),
  };
}

router.put('/me', requireUser, async (req, res, next) => {
  try {
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim().slice(0, 60) : undefined;
    const bio = typeof req.body?.bio === 'string' ? req.body.bio.trim().slice(0, 280) : undefined;
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) : undefined;
    if (displayName !== undefined && displayName.length < 1) return res.status(400).json({ message: 'Display name cannot be empty.' });
    if (username !== undefined) {
      if (username.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters.' });
      const taken = await query('SELECT 1 FROM profiles WHERE username = $1 AND user_id <> $2', [username, req.user.id]);
      if (taken.rowCount) return res.status(409).json({ message: 'That username is taken.' });
    }
    await query(
      `UPDATE profiles SET
         display_name = coalesce($2, display_name),
         bio = coalesce($3, bio),
         username = coalesce($4, username),
         updated_at = now()
       WHERE user_id = $1`,
      [req.user.id, displayName ?? null, bio ?? null, username ?? null],
    );
    res.json(await mePayload(req.user.id));
  } catch (err) { next(err); }
});

const PRIVACY_ENUMS = {
  whoCanMessage: new Set(['everyone', 'friends', 'followers', 'nobody']),
  whoCanFriend: new Set(['everyone', 'friends', 'followers', 'nobody']),
  whoCanFollow: new Set(['everyone', 'nobody']),
  storyVisibility: new Set(['everyone', 'friends', 'followers', 'nobody']),
};

router.get('/settings/privacy', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT is_private, who_can_message, who_can_friend, who_can_follow, show_online, read_receipts, story_visibility FROM profiles WHERE user_id = $1',
      [req.user.id],
    );
    const p = rows[0];
    if (!p) return res.status(404).json({ message: 'Profile not found' });
    res.json({
      isPrivate: Boolean(p.is_private),
      whoCanMessage: p.who_can_message, whoCanFriend: p.who_can_friend,
      whoCanFollow: p.who_can_follow, storyVisibility: p.story_visibility,
      showOnline: Boolean(p.show_online), readReceipts: Boolean(p.read_receipts),
    });
  } catch (err) { next(err); }
});

router.put('/settings/privacy', requireUser, async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const sets = [];
    const vals = [req.user.id];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (typeof b.isPrivate === 'boolean') put('is_private', b.isPrivate);
    if (typeof b.showOnline === 'boolean') put('show_online', b.showOnline);
    if (typeof b.readReceipts === 'boolean') put('read_receipts', b.readReceipts);
    for (const [key, col] of Object.entries({ whoCanMessage: 'who_can_message', whoCanFriend: 'who_can_friend', whoCanFollow: 'who_can_follow', storyVisibility: 'story_visibility' })) {
      if (typeof b[key] === 'string' && PRIVACY_ENUMS[key].has(b[key])) put(col, b[key]);
    }
    if (!sets.length) return res.status(400).json({ message: 'No updatable fields.' });
    sets.push('updated_at = now()');
    await query(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = $1`, vals);
    const { rows } = await query('SELECT is_private, who_can_message, who_can_friend, who_can_follow, show_online, read_receipts, story_visibility FROM profiles WHERE user_id = $1', [req.user.id]);
    const p = rows[0];
    res.json({
      isPrivate: Boolean(p.is_private), whoCanMessage: p.who_can_message, whoCanFriend: p.who_can_friend,
      whoCanFollow: p.who_can_follow, storyVisibility: p.story_visibility,
      showOnline: Boolean(p.show_online), readReceipts: Boolean(p.read_receipts),
    });
  } catch (err) { next(err); }
});

router.get('/entitlements', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT kind, status FROM entitlements WHERE user_id = $1 AND (ends_at IS NULL OR ends_at > now()) AND status IN ('trial','active','grace')",
      [req.user.id],
    );
    const kinds = new Set(rows.map((r) => r.kind));
    res.json({ nyxaiPlus: kinds.has('nyxai_plus'), premiumVerify: kinds.has('premium_verify') });
  } catch (err) { next(err); }
});

// ================= STUDIO =================

router.get('/studio', requireUser, async (req, res, next) => {
  try {
    const range = [7, 28, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 7;
    const views = await query(
      `SELECT count(*) AS n FROM post_views pv JOIN posts p ON p.id = pv.post_id
        WHERE p.author_id = $1 AND pv.created_at > now() - ($2 || ' days')::interval`,
      [req.user.id, range],
    );
    const followers = await query(
      "SELECT count(*) AS n FROM follows WHERE following_id = $1 AND created_at > now() - ($2 || ' days')::interval",
      [req.user.id, range],
    );
    const coins = await query(
      "SELECT coalesce(sum(amount), 0) AS n FROM coin_ledger WHERE user_id = $1 AND direction = 'in' AND created_at > now() - ($2 || ' days')::interval",
      [req.user.id, range],
    );
    const renders = await query(
      'SELECT id, prompt, status, output_url, created_at FROM nyx_video_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 6',
      [req.user.id],
    );
    res.json({
      range,
      views: Number(views.rows[0].n),
      followers: Number(followers.rows[0].n),
      coins: Number(coins.rows[0].n),
      avgWatch: null, // no watch-time telemetry yet — surfaced honestly as null
      renders: renders.rows.map((r) => ({
        id: r.id, title: String(r.prompt).slice(0, 70),
        status: r.status === 'ready' || r.output_url ? 'ready' : r.status === 'failed' ? 'failed' : 'rendering',
        progress: null, outputUrl: r.output_url ?? null,
      })),
    });
  } catch (err) { next(err); }
});

// ================= ADMIN (role-gated) =================

async function requireAdmin(req, res, next) {
  const { rows } = await query('SELECT role FROM profiles WHERE user_id = $1', [req.user.id]);
  const role = rows[0]?.role;
  if (!['moderator', 'admin', 'super_admin'].includes(role)) return res.status(403).json({ message: 'Admin only' });
  next();
}

router.get('/admin/overview', requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const dau = await query("SELECT count(distinct user_id) AS n FROM login_events WHERE created_at >= date_trunc('day', now())");
    const postsToday = await query("SELECT count(*) AS n FROM posts WHERE created_at >= date_trunc('day', now()) AND is_removed = false");
    const reportsOpen = await query("SELECT count(*) AS n FROM reports WHERE status = 'open'");
    res.json({ dau: Number(dau.rows[0].n), postsToday: Number(postsToday.rows[0].n), reportsOpen: Number(reportsOpen.rows[0].n), revenueMrr: null });
  } catch (err) { next(err); }
});

router.get('/admin/reports', requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.id, r.category, r.target_kind, r.target_id, r.details, r.created_at, pr.username AS reporter
         FROM reports r JOIN profiles pr ON pr.user_id = r.reporter_id
        WHERE r.status = 'open' ORDER BY r.created_at ASC LIMIT 50`,
    );
    res.json(rows.map((r) => ({
      id: r.id,
      subject: `${r.category} — ${r.target_kind}`,
      reporter: r.reporter, target: r.target_id, details: r.details ?? '',
      createdAt: asIso(r.created_at),
    })));
  } catch (err) { next(err); }
});

router.post('/admin/reports/:id', requireUser, requireAdmin, async (req, res, next) => {
  try {
    const action = String(req.body?.action ?? '');
    if (!['dismiss', 'remove'].includes(action)) return res.status(400).json({ message: 'action must be dismiss|remove' });
    const { rowCount } = await query(
      `UPDATE reports SET status = $2, resolution = $2, resolved_by = $3, resolved_at = now()
        WHERE id = $1 AND status = 'open'`,
      [req.params.id, action === 'dismiss' ? 'dismissed' : 'resolved', req.user.id],
    );
    res.json({ ok: rowCount > 0 });
  } catch (err) { next(err); }
});

// ================= STICKER PACK CREATION =================
// Creates a pack from a title + emoji list and installs it for the creator.
router.post('/stickers', requireUser, async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? '').trim().slice(0, 60);
    const raw = Array.isArray(req.body?.stickers) ? req.body.stickers.map((x) => String(x).trim()).filter(Boolean) : [];
    const stickers = [...new Set(raw)].slice(0, 60);
    if (title.length < 2) return res.status(400).json({ message: 'Pack title required (min 2 chars).' });
    if (stickers.length === 0) return res.status(400).json({ message: 'Add at least one sticker emoji.' });
    for (const e of stickers) {
      if (e.length > 16) return res.status(400).json({ message: 'Stickers must be single emoji.' });
    }
    const me = await query('SELECT display_name FROM profiles WHERE user_id = $1', [req.user.id]);
    const packId = rid();
    await query('INSERT INTO sticker_packs (id, title, author_name, created_at) VALUES ($1, $2, $3, now())',
      [packId, title, me.rows[0]?.display_name ?? 'You']);
    let order = 0;
    for (const emoji of stickers) {
      await query('INSERT INTO stickers (id, pack_id, emoji, svg, sort_order) VALUES ($1, $2, $3, $4, $5)',
        [rid(), packId, emoji, `<text>${emoji}</text>`, order++]);
    }
    await query('INSERT INTO user_sticker_packs (user_id, pack_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, packId]);
    res.status(201).json({ id: packId, title, stickers });
  } catch (err) { next(err); }
});

// ================= NYXAI CHAT =================
// Provider-agnostic: uses ANTHROPIC_API_KEY or OPENAI_API_KEY when configured;
// otherwise falls back to a grounded recap built from the user's own data.
async function nyxaiContext(userId) {
  const [posts, views, coinsIn, followers, unread, interests] = await Promise.all([
    query("SELECT count(*) AS n FROM posts WHERE author_id = $1 AND is_removed = false AND created_at > now() - interval '7 days'", [userId]),
    query("SELECT count(*) AS n FROM post_views pv JOIN posts p ON p.id = pv.post_id WHERE p.author_id = $1 AND pv.created_at > now() - interval '7 days'", [userId]),
    query("SELECT coalesce(sum(amount), 0) AS n FROM coin_ledger WHERE user_id = $1 AND direction = 'in' AND created_at > now() - interval '7 days'", [userId]),
    query("SELECT count(*) AS n FROM follows WHERE following_id = $1 AND created_at > now() - interval '7 days'", [userId]),
    query('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND is_read = false', [userId]),
    query('SELECT tag FROM user_interests WHERE user_id = $1 LIMIT 8', [userId]),
  ]);
  return {
    posts: Number(posts.rows[0].n),
    views: Number(views.rows[0].n),
    coinsIn: Number(coinsIn.rows[0].n),
    followers: Number(followers.rows[0].n),
    unread: Number(unread.rows[0].n),
    interests: interests.rows.map((r) => r.tag),
  };
}

async function callAnthropic(apiKey, system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.NYXAI_MODEL ?? 'claude-3-5-haiku-20241022', max_tokens: 600, system, messages }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return data?.content?.find((b) => b.type === 'text')?.text ?? '';
}

async function callOpenAi(apiKey, system, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.NYXAI_MODEL ?? 'gpt-4o-mini', max_tokens: 600,
      messages: [{ role: 'system', content: system }, ...messages] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

router.post('/nyxai/chat', requireUser, async (req, res, next) => {
  try {
    const text = String(req.body?.message ?? '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ message: 'Say something first.' });
    const ctx = await nyxaiContext(req.user.id);
    const system = [
      'You are NYXAI, the assistant inside the NYX night-culture social network.',
      'Be concise (under 120 words), warm, and concrete. Use the user context when relevant.',
      `User context: ${ctx.posts} posts in the last 7 days, ${ctx.views} post views, +${ctx.coinsIn} coins earned, +${ctx.followers} followers, ${ctx.unread} unread notifications, interests: ${ctx.interests.join(', ') || 'not set'}.`,
    ].join(' ');
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '').slice(0, 1000) })) : [];
    const messages = [...history, { role: 'user', content: text }];

    let reply = null;
    if (process.env.ANTHROPIC_API_KEY) reply = await callAnthropic(process.env.ANTHROPIC_API_KEY, system, messages);
    else if (process.env.OPENAI_API_KEY) reply = await callOpenAi(process.env.OPENAI_API_KEY, system, messages);

    if (reply == null) {
      // Grounded fallback — real numbers from the user's data, honest wording.
      reply = `Here's your week on NYX: you published ${ctx.posts} post${ctx.posts === 1 ? '' : 's'}, pulled in ${ctx.views} views, earned ${ctx.coinsIn} Coins and gained ${ctx.followers} follower${ctx.followers === 1 ? '' : 's'}. You have ${ctx.unread} unread notification${ctx.unread === 1 ? '' : 's'}${ctx.interests.length ? `, and your interests are ${ctx.interests.join(', ')}` : ''}. For free-form answers, an AI provider key (ANTHROPIC_API_KEY or OPENAI_API_KEY) needs to be set on the backend.`;
    }
    res.json({ reply, grounded: { posts: ctx.posts, views: ctx.views, coinsIn: ctx.coinsIn, followers: ctx.followers, unread: ctx.unread } });
  } catch (err) { next(err); }
});

// ================= LIVE CHAT =================

router.get('/live/:id/comments', requireUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.body, c.created_at, pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified
         FROM live_comments c JOIN profiles pr ON pr.user_id = c.user_id
        WHERE c.stream_id = $1 ORDER BY c.created_at ASC LIMIT 100`,
      [req.params.id],
    );
    res.json(rows.map(mapComment));
  } catch (err) { next(err); }
});

router.post('/live/:id/comments', requireUser, async (req, res, next) => {
  try {
    const body = String(req.body?.body ?? '').trim().slice(0, 500);
    if (!body) return res.status(400).json({ message: 'Message cannot be empty.' });
    const stream = await query("SELECT id FROM live_streams WHERE id = $1 AND status = 'live'", [req.params.id]);
    if (!stream.rowCount) return res.status(404).json({ message: 'Stream is not live.' });
    const id = rid();
    await query('INSERT INTO live_comments (id, stream_id, user_id, body, created_at) VALUES ($1, $2, $3, $4, now())', [id, req.params.id, req.user.id, body]);
    const { rows } = await query(
      `SELECT c.id, c.body, c.created_at, pr.user_id AS author_id, pr.username, pr.display_name, pr.is_verified
         FROM live_comments c JOIN profiles pr ON pr.user_id = c.user_id WHERE c.id = $1`,
      [id],
    );
    res.status(201).json(mapComment(rows[0]));
  } catch (err) { next(err); }
});

export default router;
