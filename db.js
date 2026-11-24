import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString || !connectionString.trim()) {
  throw new Error('DATABASE_URL is not set — refusing to start without Postgres.');
}

export const pool = new Pool({ connectionString, max: 10 });
export const query = (text, params) => pool.query(text, params);

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply migrations/auth/*.sql first (auth is opt-in upstream, on here), then migrations/*.sql — each in one transaction, tracked in _migrations. Idempotent. */
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS _migrations (name text primary key, applied_at timestamptz not null default now())');
    const applied = new Set((await client.query('SELECT name FROM _migrations')).rows.map((r) => r.name));

    const plan = [];
    try {
      const authFiles = await readdir(join(MIGRATIONS_DIR, 'auth'));
      for (const f of authFiles.sort()) if (f.endsWith('.sql')) plan.push({ name: `auth/${f}`, path: join(MIGRATIONS_DIR, 'auth', f) });
    } catch { /* no auth dir */ }
    const appFiles = await readdir(MIGRATIONS_DIR);
    for (const f of appFiles.sort()) if (f.endsWith('.sql')) plan.push({ name: f, path: join(MIGRATIONS_DIR, f) });

    let appliedCount = 0;
    for (const step of plan) {
      if (applied.has(step.name)) continue;
      const text = await readFile(step.path, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [step.name]);
        await client.query('COMMIT');
        appliedCount += 1;
        console.log(`[migrate] applied ${step.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`[migrate] ${step.name} failed: ${err.message}`);
      }
    }
    console.log(`[migrate] up to date (${appliedCount} new, ${applied.size} already applied)`);
  } finally {
    client.release();
  }
}

/** Deterministic avatar color from a user id (profiles has no color column). */
const PALETTE = ['#c8f04d', '#7ee0ff', '#ff4d9a', '#e8c27a', '#ff4d6d', '#a78bfa', '#34d399', '#60a5fa'];
export function avatarColor(id) {
  let h = 2166136261 >>> 0;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return PALETTE[h % PALETTE.length];
}
