import './polyfill.js';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { toNodeHandler } from 'better-auth/node';
import { pool, query } from './db.js';

const env = (k) => (process.env[k]?.trim() ? process.env[k].trim() : undefined);
const baseURL = env('BETTER_AUTH_URL') ?? 'http://localhost:3000';

const emailAndPassword = { enabled: true, minPasswordLength: 8 };

// Password reset: enabled when SMTP_URL (smtp(s)://user:pass@host:port) is configured;
// without it the reset endpoint is not exposed and the RN screen reports it.
const smtpUrl = env('SMTP_URL');
if (smtpUrl) {
  emailAndPassword.sendResetPassword = async ({ user, url }) => {
    const { default: nodemailer } = await import('nodemailer');
    const transporter = nodemailer.createTransport(smtpUrl);
    await transporter.sendMail({
      from: env('SMTP_FROM') ?? 'NYX <no-reply@nyx.app>',
      to: user.email,
      subject: 'Reset your NYX password',
      text: `Reset your NYX password: ${url}`,
    });
  };
}

export const auth = betterAuth({
  baseURL,
  secret: env('BETTER_AUTH_SECRET') ?? 'INSECURE-DEV-SECRET-CHANGE-ME',
  database: pool,
  emailAndPassword,
  trustedOrigins: [baseURL, env('NYX_WEB_ORIGIN'), 'http://localhost:8081', 'http://localhost:8080', 'nyx://'].filter(Boolean),
  session: { cookieCache: { enabled: true, maxAge: 300 } },
  advanced: {
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true, sameSite: 'lax', path: '/' },
    cookies: { session_token: { name: '__Host-nyx.session_token' } },
  },
  // Mobile clients send no Origin header; browsers use the cookie path above.
  plugins: [bearer()],
  databaseHooks: {
    user: {
      create: {
        // Every auth-user gets a kchat profile + wallet, mirroring production.
        after: async (user) => {
          const base = String(user.email ?? 'user').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20) || 'user';
          let username = base, i = 1;
          for (;;) {
            const clash = await query('SELECT 1 FROM profiles WHERE username_lc = $1', [username.toLowerCase()]);
            if (clash.rowCount === 0) break;
            username = `${base}${++i}`;
          }
          const name = (user.name && String(user.name).trim()) || username;
          await query(
            `INSERT INTO profiles (user_id, username, username_lc, display_name, onboarded) VALUES ($1, $2, $3, $4, false)
             ON CONFLICT (user_id) DO NOTHING`,
            [user.id, username, username.toLowerCase(), name],
          );
          await query('INSERT INTO coin_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [user.id]);
        },
      },
    },
  },
});

export const authHandler = toNodeHandler(auth);

/** Build a Web Headers object from the Express request. */
function toHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return headers;
}

/** Express middleware: resolve the better-auth session (cookie or Bearer) or 401. */
export async function requireUser(req, res, next) {
  try {
    const session = await auth.api.getSession({ headers: toHeaders(req) });
    if (!session?.user) return res.status(401).json({ message: 'Unauthorized' });
    req.user = session.user;
    req.session = session.session;
    next();
  } catch (err) {
    next(err);
  }
}
