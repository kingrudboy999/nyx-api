/**
 * Demo seed — opt-in via SEED_DEMO=1. Idempotent: skips when the NYXAI user
 * already exists. Creates the demo account (demo@nyx.app / nyxdemo123),
 * the night-feed creator cast, and real rows (posts, likes, comments,
 * stories, live streams, notifications, DMs) mirroring the app's demo copy.
 */
import './polyfill.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pool, query, migrate } from './db.js';
import { auth } from './auth.js';

const DEMO_EMAIL = 'demo@nyx.app';
const DEMO_PASSWORD = 'nyxdemo123';
const id = () => randomUUID();
const mins = (m) => new Date(Date.now() - m * 60_000);
const hrs = (h) => new Date(Date.now() - h * 3_600_000);

export async function runSeed() {
await migrate();
const exists = await query(`SELECT 1 FROM profiles WHERE username_lc = 'nyxai'`);
if (exists.rowCount) {
  console.log('[seed] demo data already present — skipping');
  return;
}

// ---- 1) demo account through better-auth (hook creates its profile) ----
try {
  await auth.api.signUpEmail({ body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: 'Demo Nyx' } });
} catch (err) {
  console.log('[seed] demo account exists or sign-up unavailable:', err?.message ?? err);
}
const demoRow = await query(`SELECT id FROM "user" WHERE email = $1`, [DEMO_EMAIL]);
const DEMO_ID = demoRow.rows[0]?.id;
if (!DEMO_ID) throw new Error('[seed] demo user missing after sign-up');

// ---- 2) creator cast (no credentials) + shadow users (interactions) ----
const cast = [
  { username: 'atlas_', name: 'Atlas', verified: true },
  { username: 'kiki.wav', name: 'Kiki' },
  { username: 'moonlit', name: 'Moonlit' },
  { username: 'frame.by.fey', name: 'Fey', verified: true },
  { username: 'nyxai', name: 'NYXAI', verified: true },
  { username: 'waveform_', name: 'Waveform' },
  { username: 'nocturne', name: 'Nocturne' },
  { username: 'dimanalog', name: 'Dim Analog' },
];
const castId = {};
for (const u of cast) {
  const uid = id();
  castId[u.username] = uid;
  await query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())`,
    [uid, u.name, `${u.username.replace(/\./g, '_')}@seed.nyx.app`],
  );
  await query(
    `INSERT INTO profiles (user_id, username, username_lc, display_name, bio, is_verified, onboarded)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [uid, u.username, u.username.toLowerCase(), u.name,
      { 'atlas_': 'Rooftop DJ · Atlas Live', 'kiki.wav': 'singer/producer — “Streetlights Hum”', moonlit: '2am feed curator', 'frame.by.fey': 'film photographer', nyxai: 'The network’s host intelligence', waveform_: 'sound designer', nocturne: 'late keys', dimanalog: 'creator of the week' }[u.username] ?? '',
      Boolean(u.verified)],
  );
  await query('INSERT INTO coin_wallets (user_id) VALUES ($1)', [uid]);
}

const SHADOW = 24;
const shadowIds = [];
for (let i = 1; i <= SHADOW; i++) {
  const uid = id();
  shadowIds.push(uid);
  const uname = `night_owl_${i}`;
  await query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, now(), now())`,
    [uid, uname, `${uname}@seed.nyx.app`],
  );
  await query(
    `INSERT INTO profiles (user_id, username, username_lc, display_name, onboarded) VALUES ($1, $2, $2, $2, true)`,
    [uid, uname],
  );
}

// ---- 3) demo profile: identity, verified, wallet, entitlement, follows ----
await query(
  `UPDATE profiles SET username = 'you', username_lc = 'you', display_name = 'Demo Nyx',
          bio = 'Reviewing the NYX React Native client', onboarded = true, is_verified = true, updated_at = now()
   WHERE user_id = $1`,
  [DEMO_ID],
);
await query('UPDATE coin_wallets SET balance = 640, updated_at = now() WHERE user_id = $1', [DEMO_ID]);
await query(
  `INSERT INTO entitlements (id, user_id, kind, source, status) VALUES ($1, $2, 'nyxai_plus', 'arc_grant', 'active')`,
  [id(), DEMO_ID],
);
for (const f of ['atlas_', 'kiki.wav', 'nyxai', 'frame.by.fey', 'moonlit']) {
  await query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [DEMO_ID, castId[f]]);
}

// ---- 4) posts (the demo feed copy) + interactions ----
const seedPosts = [
  { author: 'atlas_', body: 'Night market set tonight — Atlas live from the rooftop. NYXAI clipped the best 30s. #live', age: mins(4), tags: ['live', 'atlaslive', 'nightmarket'], views: 24812, likes: 18, comments: 9 },
  { author: 'kiki.wav', body: 'POV: the city finally dims and the feed comes alive.\nNew single “Streetlights Hum” is up on NYX Music.', age: mins(18), tags: ['streetlightshum', 'nyxmusic'], views: 15320, likes: 14, comments: 6 },
  { author: 'moonlit', body: 'Atlas tier check: is anyone else’s feed this calm after 2am? Share your late-night rituals below.', age: mins(46), tags: ['2amfeed'], views: 9821, likes: 11, comments: 15 },
  { author: 'frame.by.fey', body: 'Shot on a 2011 phone, edited on the train, posted before the lights came back.', age: mins(93), tags: ['film'], views: 41003, likes: 20, comments: 8 },
  { author: 'nyxai', body: 'Your For You ranked itself overnight. 14 creators you follow went live while you slept.', age: hrs(2), tags: ['tech'], views: 88210, likes: 17, comments: 12 },
];
const postIds = [];
for (const p of seedPosts) {
  const pid = id();
  postIds.push(pid);
  await query(
    `INSERT INTO posts (id, author_id, body, kind, created_at, updated_at, published_at, view_count)
     VALUES ($1, $2, $3, 'post', $4, $4, $4, $5)`,
    [pid, castId[p.author], p.body, p.age, p.views],
  );
  for (const tag of p.tags) {
    await query('INSERT INTO post_hashtags (post_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING', [pid, tag]);
  }
  for (let i = 0; i < p.likes; i++) {
    await query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [pid, shadowIds[i % shadowIds.length]]);
  }
  for (let i = 0; i < p.comments; i++) {
    await query(
      `INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [id(), pid, shadowIds[(i + 3) % shadowIds.length], ['this is the one', '2am feed checks out', 'fr', 'insane energy', 'okay the algorithm cooked'][i % 5], new Date(p.age.getTime() + (i + 1) * 90_000)],
    );
  }
}

// ---- 5) hashtags (trending) ----
const tags = { streetlightshum: 2400, atlaslive: 1900, nyxmusic: 1500, live: 900, nightmarket: 800, '2amfeed': 600 };
for (const [tag, uses] of Object.entries(tags)) {
  await query(
    `INSERT INTO hashtags (tag, use_count, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (tag) DO UPDATE SET use_count = GREATEST(hashtags.use_count, EXCLUDED.use_count), updated_at = now()`,
    [tag, uses],
  );
}

// ---- 6) stories (active) + story views (moonlit seen by demo) ----
const storyDefs = [
  { author: 'kiki.wav', seen: false }, { author: 'atlas_', seen: false }, { author: 'moonlit', seen: true },
  { author: 'nyxai', seen: false }, { author: 'frame.by.fey', seen: true },
];
for (const s of storyDefs) {
  const sid = id();
  await query(
    `INSERT INTO stories (id, author_id, media_url, media_kind, expires_at, created_at)
     VALUES ($1, $2, NULL, 'text', now() + interval '8 hours', now() - interval '30 minutes')`,
    [sid, castId[s.author]],
  );
  if (s.seen) await query('INSERT INTO story_views (story_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sid, DEMO_ID]);
}

// ---- 7) live streams ----
const liveDefs = [
  { host: 'atlas_', title: 'Rooftop set — Atlas live', peak: 2142, status: 'live' },
  { host: 'kiki.wav', title: 'Late-night synth mix', peak: 684, status: 'live' },
  { host: 'nyxai', title: 'NYXAI midnight drops', peak: 1300, status: 'live' },
  { host: 'frame.by.fey', title: 'Editing on the train, ep. 4', peak: 12000, status: 'ended', ended: true },
];
for (const l of liveDefs) {
  await query(
    `INSERT INTO live_streams (id, host_id, title, status, viewer_peak, room_code, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '40 minutes', CASE WHEN $7 THEN now() END)`,
    [id(), castId[l.host], l.title, l.status, l.peak, `seed-${id().slice(0, 8)}`, Boolean(l.ended)],
  );
}

// ---- 8) notifications (5 unread, the demo set) ----
const notifDefs = [
  { kind: 'like', body: 'kiki.wav and 84 others liked your Flash', age: mins(1) },
  { kind: 'mention', body: 'atlas_ mentioned you in a comment', age: mins(22) },
  { kind: 'follow', body: 'frame.by.fey started following you', age: hrs(1) },
  { kind: 'live', body: 'Atlas is live — rooftop set', age: hrs(2) },
  { kind: 'coin', body: 'You earned 25 NYX Coins from a live streak', age: hrs(5) },
];
for (const n of notifDefs) {
  await query(
    `INSERT INTO notifications (id, user_id, kind, body, is_read, created_at) VALUES ($1, $2, $3, $4, false, $5)`,
    [id(), DEMO_ID, n.kind, n.body, n.age],
  );
}

// ---- 9) DMs: atlas (2 unread) + kiki (1 unread) ----
const dmDefs = [
  { partner: 'atlas_', lines: [['them', 'yo, you up?', 30], ['me', 'always after midnight', 28], ['them', 'the rooftop clip is wild, watch it', 12]] },
  { partner: 'kiki.wav', lines: [['them', 'new single drops at midnight', 25], ['me', 'on it. setting an alarm', 22]] },
  { partner: 'moonlit', lines: [['them', '2am feed check — come say hi', 8]] },
];
// last_read is set 1h ago so every seeded partner message is unread.
for (const dm of dmDefs) {
  const cid = id();
  await query(
    `INSERT INTO conversations (id, kind, created_by, created_at, last_message_at) VALUES ($1, 'dm', $2, now() - interval '3 hours', now() - interval '2 minutes')`,
    [cid, castId[dm.partner]],
  );
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_at, joined_at) VALUES ($1, $2, 'member', now() - interval '1 hour', now() - interval '3 hours')`,
    [cid, DEMO_ID],
  );
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_at, joined_at) VALUES ($1, $2, 'member', now(), now() - interval '3 hours')`,
    [cid, castId[dm.partner]],
  );
  for (const [from, body, ageMin] of dm.lines) {
    await query(
      `INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at) VALUES ($1, $2, $3, 'text', $4, $5)`,
      [id(), cid, from === 'me' ? DEMO_ID : castId[dm.partner], body, mins(ageMin)],
    );
  }
}

console.log('[seed] demo dataset seeded. Demo login:', DEMO_EMAIL, '/', DEMO_PASSWORD);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed().then(() => pool.end()).catch(async (err) => { console.error('[seed] failed:', err); await pool.end(); process.exit(1); });
}
