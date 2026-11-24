# nyx-api

Backend API for the NYX network (React Native client in this repo).

- **Postgres** — the full production schema from the original web app, applied
  by `migrate.js` from `migrations/` (auth schema first, then app migrations;
  tracked in `_migrations`, each file in one transaction).
- **Better Auth** at `/api/auth/*` — email/password + Bearer sessions
  (the mobile app stores the `set-auth-token` response header). Every
  auth-user automatically gets a `profiles` row and a `coin_wallets` row.
- **REST parity routes** (what the RN client calls when `EXPO_PUBLIC_NYX_MOCK=0`):
  `GET /api/me` · `GET /api/feed?tab=&cursor=` · `GET /api/stories`
  `GET /api/trending-tags` · `GET /api/live` · `GET /api/inbox/unread`
  `GET /api/alerts/unread` · `POST /api/interests` `{tags[]}`
- `GET /health` — liveness probe.

## Demo data

`SEED_DEMO=1` on boot (idempotent) seeds the night-feed cast and the demo
account, mirroring the app's demo copy with **real rows** (like/comment/view
counts are real; `posts.view_count` is seeded for realism):

- **demo@nyx.app / nyxdemo123** (verified, NYXAI Plus entitlement, wallet 640,
  follows the cast) — sign in from the app with MOCK off.

## Not wired yet (by design)

The original web backend is ~24k lines of server functions (RTC signaling,
billing/store verification, video pipeline, admin, NYXAI orchestration).
Those are **not** ported into this REST service yet; the RN client does not
call them (all app data flows through the parity routes above and currently
defaults to the bundled demo dataset until `EXPO_PUBLIC_NYX_MOCK=0`).
Port them incrementally as `routes/` modules reusing `migrations/`.

Password reset requires `SMTP_URL`; without it the reset endpoint is absent
and the app surfaces a "not available" error. Feed ranking (`foryou`) is
chronological until the ranker is ported; `trending` orders by likes.
