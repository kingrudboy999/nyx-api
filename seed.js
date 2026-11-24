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
  console.log('[seed] phase 1 present — ensuring phase 2');
  await runSeedPhase2();
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
await runSeedPhase2();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed().then(() => pool.end()).catch(async (err) => { console.error('[seed] failed:', err); await pool.end(); process.exit(1); });
}

// ---- Phase 2: spaces/events/challenges/stickers/lists/studio renders (per-section guards, safe to re-run) ----
export async function runSeedPhase2() {
  const demo = await query(`SELECT user_id FROM profiles WHERE username_lc = 'you'`);
  const DEMO_ID = demo.rows[0]?.user_id ?? null;
  const castRow = await query(`SELECT user_id, username FROM profiles WHERE username_lc IN ('atlas_','kiki.wav','moonlit','nyxai','frame.by.fey','waveform_')`);
  const cast = Object.fromEntries(castRow.rows.map((r) => [r.username, r.user_id]));

  // Communities (real counts — only the members we actually insert)
  const hasComm = await query('SELECT 1 FROM communities LIMIT 1');
  if (!hasComm.rowCount) {
    const communityDefs = [
      { name: 'Night Feed Society', tag: 'culture', desc: 'The 2am current — feed drops, rooftop sets, and what the city is listening to.', creator: 'atlas_' },
      { name: 'Atlas tier', tag: 'music', desc: 'House, breaks and rooftop culture. Tour notes and setlists.', creator: 'atlas_' },
      { name: 'Frame & Film', tag: 'film', desc: 'Shot on phones, developed in the dark. Share your night photography.', creator: 'frame.by.fey' },
      { name: 'Late-night Dev', tag: 'tech', desc: 'Builders who ship after midnight. Show your work, ask for review.', creator: 'nyxai' },
    ];
    const communityIds = [];
    for (const c of communityDefs) {
      const cid = id();
      communityIds.push([cid, c]);
      const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await query(
        `INSERT INTO communities (id, kind, slug, name, description, about, category, created_by, member_count, created_at)
         VALUES ($1, 'community', $2, $3, $4, $4, $5, $6, 1, now())`,
        [cid, slug, c.name, c.desc, c.tag, cast[c.creator] ?? DEMO_ID],
      );
      await query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [cid, cast[c.creator] ?? DEMO_ID]);
      await query('INSERT INTO community_rules (id, community_id, title, body, sort_order) VALUES ($1, $2, $3, $4, 1)',
        [id(), cid, 'Post the best of the night', 'Keep it loud, weird, and a little beautiful.']);
    }
    // cast membership is deterministic: everyone joins every cast-made community except their own
    for (const [cid, c] of communityIds) {
      for (const [name, other] of Object.entries(cast)) {
        if (other && name !== c.creator) {
          await query('INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [cid, other, 'member']);
        }
      }
      if (DEMO_ID) {
        await query("INSERT INTO community_members (community_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING", [cid, DEMO_ID]);
      }
      const count = await query('SELECT count(*) AS n FROM community_members WHERE community_id = $1', [cid]);
      await query('UPDATE communities SET member_count = $2 WHERE id = $1', [cid, Number(count.rows[0].n)]);
    }
    // one seeded post with a couple of votes
    if (DEMO_ID && communityIds[0]) {
      const pid = id();
      await query(
        `INSERT INTO community_posts (id, community_id, author_id, title, body, upvotes, score, created_at) VALUES ($1, $2, $3, $4, $5, 2, 2, now() - interval '2 hours')`,
        [pid, communityIds[0][0], cast['atlas_'] ?? DEMO_ID, 'Night market set — full tracklist', 'Rooftop run went long. Full set tonight, bring friends.'],
      );
    }
    console.log('[seed] communities seeded');
  }

  // Events (upcoming, copied demo copy)
  const hasEvent = await query('SELECT 1 FROM nyx_events LIMIT 1');
  if (!hasEvent.rowCount && DEMO_ID) {
    const host = cast['atlas_'] ?? DEMO_ID;
    const events = [
      { title: 'Rooftop Session #12', desc: 'Atlas live from the Victoria Island rooftop — two sets, one skyline.', hours: 6, loc: 'Victoria Island rooftop', host },
      { title: 'NYX Live: Kiki — Streetlights Hum', desc: 'Streaming live on NYX. Bring headphones.', hours: 48, loc: 'Live on NYX', host: cast['kiki.wav'] ?? DEMO_ID },
      { title: 'Creator meetup — Lagos night market', desc: 'Frame, film and print trading at the Lekki night market.', hours: 72, loc: 'Lekki night market', host: cast['moonlit'] ?? DEMO_ID },
    ];
    for (const e of events) {
      const eid = id();
      await query(
        `INSERT INTO nyx_events (id, host_id, title, description, starts_at, location, is_online, created_at)
         VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval, $6, $7, now())`,
        [eid, e.host, e.title, e.desc, String(e.hours), e.loc, e.loc === 'Live on NYX'],
      );
      await query("INSERT INTO event_rsvps (event_id, user_id, status) VALUES ($1, $2, 'going') ON CONFLICT DO NOTHING", [eid, DEMO_ID]);
      for (const other of Object.values(cast)) if (other) await query("INSERT INTO event_rsvps (event_id, user_id, status) VALUES ($1, $2, 'going') ON CONFLICT DO NOTHING", [eid, other]);
    }
    console.log('[seed] events seeded');
  }

  // Challenges (open, honest counters)
  const hasChallenge = await query('SELECT 1 FROM challenges LIMIT 1');
  if (!hasChallenge.rowCount && DEMO_ID) {
    const challenges = [
      { title: '7-day night streak', hashtag: 'nightfeedstreak', rules: 'Post at least one Flash a day, every day, for 7 nights. Streaks freeze once.' },
      { title: 'Post 3 Flashes', hashtag: 'flashthree', rules: 'Three Flashes this week. Anything goes as long as it is yours.' },
      { title: 'Streetlights Hum remix week', hashtag: 'streetlightshumremix', rules: 'Your remix, your rules — tag the hashtag, we will play the best on NYX Live.' },
    ];
    for (const c of challenges) {
      await query(
        `INSERT INTO challenges (id, creator_id, title, rules, hashtag, deadline, created_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '14 days', now())`,
        [id(), cast['atlas_'] ?? DEMO_ID, c.title, c.rules, c.hashtag],
      );
    }
    console.log('[seed] challenges seeded');
  }

  // Sticker packs + stickers
  const hasPack = await query('SELECT 1 FROM sticker_packs LIMIT 1');
  if (!hasPack.rowCount) {
    const packDefs = [
      { title: 'Night NYX', author: 'NYX', emojis: ['🌙','✨','🛹','🌃','🎧','📼','🪩','☕','🕹️','🌆','🎛️','🌃'] },
      { title: 'NYX Core', author: 'NYX', emojis: ['🎨','🔥','💎','⚡','🛸','🫶','🌊','⭐'] },
      { title: 'Festival Nights', author: 'NYX', emojis: ['🎪','🎡','🪩','🎆','🎇','🕶️','🥤','🎷'] },
    ];
    for (const p of packDefs) {
      const packId = id();
      await query('INSERT INTO sticker_packs (id, title, author_name, created_at) VALUES ($1, $2, $3, now())', [packId, p.title, p.author]);
      let order = 0;
      for (const emoji of p.emojis) {
        await query('INSERT INTO stickers (id, pack_id, emoji, svg, sort_order) VALUES ($1, $2, $3, $4, $5)', [id(), packId, emoji, `<text>${emoji}</text>`, order++]);
      }
    }
    if (DEMO_ID) {
      const installed = await query('SELECT id FROM sticker_packs ORDER BY created_at ASC LIMIT 2');
      for (const row of installed.rows) await query('INSERT INTO user_sticker_packs (user_id, pack_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [DEMO_ID, row.id]);
    }
    console.log('[seed] stickers seeded');
  }

  // Lists for the demo account
  const hasList = await query('SELECT 1 FROM user_lists LIMIT 1');
  if (!hasList.rowCount && DEMO_ID) {
    const listDefs = [
      { name: 'Late night music', desc: 'Sets, singles and 2am frequencies.', members: ['atlas_', 'kiki.wav'] },
      { name: 'Lagos creators', desc: 'The Lagos night feed.', members: ['atlas_', 'frame.by.fey', 'moonlit'] },
    ];
    for (const l of listDefs) {
      const listId = id();
      await query(
        "INSERT INTO user_lists (id, owner_id, name, description, is_private, created_at, updated_at) VALUES ($1, $2, $3, $4, false, now() - interval '6 hours', now() - interval '3 hours')",
        [listId, DEMO_ID, l.name, l.desc],
      );
      for (const u of l.members) {
        if (cast[u]) await query('INSERT INTO user_list_members (list_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [listId, cast[u]]);
      }
    }
    console.log('[seed] lists seeded');
  }

  // Sounds catalog (original night catalog) — only when the table is empty
  const hasSounds = await query('SELECT 1 FROM sounds LIMIT 1');
  if (!hasSounds.rowCount) {
    const soundDefs = [
      { title: 'Streetlights Hum (instrumental)', artist: 'atlas_', ms: 214000, uses: 187 },
      { title: 'Rooftop siren — live cut', artist: 'atlas_', ms: 183000, uses: 154 },
      { title: '2am Amapiano Pressure', artist: 'kiki.wav', ms: 247000, uses: 231 },
      { title: 'Night market after dark', artist: 'frame.by.fey', ms: 198000, uses: 98 },
      { title: 'Vinyl crackle & moonlit talk', artist: 'moonlit', ms: 226000, uses: 140 },
      { title: 'Grindcore love letter', artist: 'night_owl_2', ms: 171000, uses: 76 },
      { title: 'Harbor static (slowed)', artist: 'wave.exe', ms: 242000, uses: 118 },
      { title: 'Last bus home', artist: 'atlas_', ms: 205000, uses: 165 },
    ];
    for (const sd of soundDefs) {
      await query(
        "INSERT INTO sounds (id, author_id, title, artist, duration_ms, use_count, original, created_at) VALUES ($1, $2, $3, $4, $5, $6, true, now() - random() * interval '20 days')",
        [id(), DEMO_ID ? DEMO_ID : null, sd.title, sd.artist, sd.ms, sd.uses],
      );
    }
    console.log('[seed] sounds seeded');
  }

  // Studio render jobs (one done, one in-flight)
  const hasJob = await query('SELECT 1 FROM nyx_video_jobs LIMIT 1');
  if (!hasJob.rowCount && DEMO_ID) {
    await query(
      `INSERT INTO nyx_video_jobs (id, user_id, provider, model, prompt, status, output_url, created_at, completed_at) VALUES ($1, $2, 'runway', 'gen3a', 'Streetlights Hum — teaser, 9s', 'succeeded', NULL, now() - interval '2 days', now() - interval '2 days')`,
      [id(), DEMO_ID],
    );
    await query(
      `INSERT INTO nyx_video_jobs (id, user_id, provider, model, prompt, status, created_at) VALUES ($1, $2, 'runway', 'gen3a', 'Rooftop set — full cut', 'rendering', now() - interval '1 hour')`,
      [id(), DEMO_ID],
    );
    console.log('[seed] studio jobs seeded');
  }
}
