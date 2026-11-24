import express from 'express';
import { migrate, pool } from './db.js';
import { authHandler } from './auth.js';
import apiRouter from './routes/api.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway edge terminates TLS

// Minimal permissive CORS for RN (no Origin header) + web dev origins.
const allowed = new Set([process.env.NYX_WEB_ORIGIN, 'http://localhost:8081', 'http://localhost:8080', 'http://localhost:3000'].filter(Boolean));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowed.has(origin) || origin.endsWith('.vercel.app'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'set-auth-token');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Public health check (used for smoke tests + Railway deploy checks).
app.get('/health', (_req, res) => res.json({ ok: true, service: 'nyx-api' }));

// Better Auth owns /api/auth/* (parses its own body — keep before json parser).
app.all('/api/auth/*', authHandler);

app.use(express.json({ limit: '1mb' }));
app.use('/api', apiRouter);

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

const port = Number(process.env.PORT || 3000);

try {
  await migrate();
  if (process.env.SEED_DEMO === '1') {
    const { runSeed } = await import('./seed.js');
    try {
      await runSeed();
    } catch (err) {
      // Never crash-loop the deploy on seed failure.
      console.error('[seed] failed (continuing):', err?.message ?? err);
    }
  }
} catch (err) {
  console.error('[boot] migration failed:', err?.message ?? err);
  process.exit(1);
}

app.listen(port, '0.0.0.0', () => console.log(`[nyx-api] listening on :${port}`));
process.on('SIGTERM', () => pool.end().finally(() => process.exit(0)));
