import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { APIError } from 'better-auth/api';
import { answerQuestion, type AnswerModel, type CapConfig } from './ask.js';
import { publicUser, toAppUser, type AppUser, type Auth, type UserStatus } from './auth.js';
import type { Config } from './config.js';
import { createUsageStore } from './db.js';
import { clientIp, emailSchema, passwordSchema, readJson } from './http.js';
import type { SpeciesLabels } from './labels.js';
import { LoginChallenges } from './login-codes.js';
import { MailError, type Mailer } from './mailer.js';
import { RateLimiter } from './rate-limit.js';
import { Users } from './users.js';
import type { WikiFetcher } from './wiki.js';

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  auth: Auth;
  mailer: Mailer;
  labels: SpeciesLabels;
  wiki: WikiFetcher;
  model: AnswerModel | null;
  /** Override limits in tests. */
  limits?: { ipPerWindow?: number; emailPerWindow?: number; windowMs?: number; askPerMinute?: number };
}

export const BODY_LIMIT_BYTES = 16 * 1024;

const signupSchema = z.object({ email: emailSchema, password: passwordSchema, name: z.string().trim().max(80).optional() }).strict();
const loginSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
const verifySchema = z.object({ challenge: z.string().min(16).max(64), code: z.string().regex(/^\d{6}$/) }).strict();
const idParam = z.string().min(1).max(64);

const json = (c: Context, status: 200 | 400 | 401 | 403 | 404 | 413 | 429 | 500 | 502 | 503, body: unknown) => c.json(body, status);

export function createApp(deps: AppDeps) {
  const { config, db, auth, mailer, labels } = deps;
  const users = new Users(db);
  const challenges = new LoginChallenges(db, config.BETTER_AUTH_SECRET, config.LOGIN_CODE_TTL_SECONDS);
  const usage = createUsageStore(db);
  const caps: CapConfig = { perUserDaily: config.ASK_DAILY_PER_USER, globalDaily: config.ASK_DAILY_GLOBAL };
  const windowMs = deps.limits?.windowMs ?? 10 * 60 * 1000;
  const authByIp = new RateLimiter(deps.limits?.ipPerWindow ?? 20, windowMs);
  const loginByEmail = new RateLimiter(deps.limits?.emailPerWindow ?? 6, windowMs);
  const askByIp = new RateLimiter(deps.limits?.askPerMinute ?? 10, 60 * 1000);

  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // CORS lives here, not in Nginx: exactly the configured origins, no credentials.
  app.use(
    '/v1/*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      credentials: false,
      maxAge: 600,
    }),
  );
  app.use('/v1/*', bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));

  app.onError((err, c) => {
    console.error(`[error] ${c.req.method} ${c.req.path}: ${err.name}: ${err.message}`);
    return json(c, 500, { error: 'internal_error' });
  });
  app.notFound((c) => json(c, 404, { error: 'not_found' }));

  /** One safe line for the log: the error kind, never the recipient or the code. */
  function describeMailError(err: unknown): string {
    if (err instanceof MailError) return `${err.code}: ${err.message}`;
    return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
  }

  app.get('/health', (c) => c.json({ ok: true }));

  // ---- helpers --------------------------------------------------------------

  async function sessionUser(c: Context): Promise<{ user: AppUser; token: string } | null> {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!s) return null;
    return { user: toAppUser(s.user as unknown as Record<string, unknown>), token };
  }

  function requireAuthRate(c: Context): boolean {
    return authByIp.allow(`ip:${clientIp(c)}`);
  }

  // ---- auth -----------------------------------------------------------------

  app.post('/v1/auth/signup', async (c) => {
    if (!requireAuthRate(c)) return json(c, 429, { error: 'rate_limited' });
    const body = await readJson(c, signupSchema);
    if (!body) return json(c, 400, { error: 'invalid_request' });
    try {
      await auth.api.signUpEmail({ body: { email: body.email, password: body.password, name: body.name ?? body.email.split('@')[0] } });
    } catch (err) {
      // Existing address or weak password: respond exactly like success so addresses cannot be enumerated.
      if (!(err instanceof APIError)) throw err;
    }
    return json(c, 200, { ok: true, message: 'If the address can be registered you can now sign in. New accounts wait for approval.' });
  });

  app.post('/v1/auth/login', async (c) => {
    if (!requireAuthRate(c)) return json(c, 429, { error: 'rate_limited' });
    const body = await readJson(c, loginSchema);
    if (!body) return json(c, 400, { error: 'invalid_request' });
    if (!loginByEmail.allow(`email:${body.email}`)) return json(c, 429, { error: 'rate_limited' });
    challenges.purgeExpired();
    let token: string;
    let user: AppUser;
    try {
      const res = await auth.api.signInEmail({ body: { email: body.email, password: body.password } });
      token = res.token;
      user = toAppUser(res.user as unknown as Record<string, unknown>);
    } catch (err) {
      if (err instanceof APIError) return json(c, 401, { error: 'invalid_credentials' });
      throw err;
    }
    if (user.status === 'disabled' || user.status === 'rejected') {
      users.revokeSessions(user.id);
      return json(c, 403, { error: 'account_disabled' });
    }
    const challenge = challenges.create(user.id, user.email, token);
    try {
      await mailer.send({
        to: user.email,
        subject: 'Your Birdbrain sign-in code',
        text: `Your sign-in code is ${challenge.code}\n\nIt expires in ${Math.round(config.LOGIN_CODE_TTL_SECONDS / 60)} minutes. If you did not try to sign in to Sabih’s Birdbrain, ignore this message.`,
      });
    } catch (err) {
      // A hanging or failing SMTP path must not stall the request into the proxy timeout:
      // answer quickly and clearly. Never log the address or the code.
      console.error(`[error] login mail failed: ${describeMailError(err)}`);
      return json(c, 503, { error: 'email_unavailable' });
    }
    return json(c, 200, { challenge: challenge.id, expiresInSeconds: config.LOGIN_CODE_TTL_SECONDS });
  });

  app.post('/v1/auth/verify', async (c) => {
    if (!requireAuthRate(c)) return json(c, 429, { error: 'rate_limited' });
    const body = await readJson(c, verifySchema);
    if (!body) return json(c, 400, { error: 'invalid_request' });
    const ch = challenges.verify(body.challenge, body.code);
    if (!ch) return json(c, 401, { error: 'invalid_code' });
    users.markEmailVerified(ch.user_id);
    const user = users.get(ch.user_id);
    const expiresAt = users.sessionExpiry(ch.session_token);
    if (!user || !expiresAt) return json(c, 401, { error: 'invalid_code' });
    return json(c, 200, { token: ch.session_token, expiresAt: expiresAt.toISOString(), user: publicUser(user) });
  });

  app.post('/v1/auth/refresh', async (c) => {
    const s = await sessionUser(c);
    if (!s) return json(c, 401, { error: 'unauthorized' });
    const expiresAt = users.sessionExpiry(s.token);
    return json(c, 200, { token: s.token, expiresAt: expiresAt?.toISOString() ?? null, user: publicUser(s.user) });
  });

  app.post('/v1/auth/logout', async (c) => {
    const s = await sessionUser(c);
    if (!s) return json(c, 401, { error: 'unauthorized' });
    await auth.api.signOut({ headers: c.req.raw.headers });
    return json(c, 200, { ok: true });
  });

  app.get('/v1/me', async (c) => {
    const s = await sessionUser(c);
    if (!s) return json(c, 401, { error: 'unauthorized' });
    return json(c, 200, { user: publicUser(s.user) });
  });

  // ---- admin ----------------------------------------------------------------

  async function requireAdmin(c: Context): Promise<AppUser | null> {
    const s = await sessionUser(c);
    if (!s || s.user.role !== 'admin' || s.user.status !== 'approved') return null;
    return s.user;
  }

  app.get('/v1/admin/users', async (c) => {
    if (!(await requireAdmin(c))) return json(c, 403, { error: 'forbidden' });
    return json(c, 200, { users: users.list().map((u) => ({ ...publicUser(u), emailVerified: u.emailVerified, createdAt: u.createdAt.toISOString() })) });
  });

  const transitions: Record<string, UserStatus> = { approve: 'approved', reject: 'rejected', disable: 'disabled' };
  app.post('/v1/admin/users/:id/:action', async (c) => {
    const admin = await requireAdmin(c);
    if (!admin) return json(c, 403, { error: 'forbidden' });
    const id = idParam.safeParse(c.req.param('id'));
    const status = transitions[c.req.param('action')];
    if (!id.success || !status) return json(c, 400, { error: 'invalid_request' });
    if (id.data === admin.id) return json(c, 400, { error: 'cannot_change_own_status' });
    const target = users.get(id.data);
    if (!target) return json(c, 404, { error: 'not_found' });
    users.setStatus(id.data, status);
    let emailed = false;
    if (status === 'approved' && target.status !== 'approved') {
      // The approval itself is already saved; a mail failure must not undo or hide it.
      try {
        await mailer.send({ to: target.email, subject: 'Your Birdbrain account is approved', text: 'Sabih approved your account. Sign in again to use member features.' });
        emailed = true;
      } catch (err) {
        console.error(`[error] approval mail failed: ${describeMailError(err)}`);
      }
    }
    return json(c, 200, { ok: true, user: publicUser({ ...target, status }), emailed });
  });

  // ---- ask ------------------------------------------------------------------

  app.post('/v1/ask', async (c) => {
    if (!askByIp.allow(`ip:${clientIp(c)}`)) return json(c, 429, { error: 'rate_limited' });
    const s = await sessionUser(c);
    if (!s) return json(c, 401, { error: 'unauthorized' });
    if (!deps.model) return json(c, 502, { error: 'model_unavailable' });
    let raw: unknown;
    try {
      raw = (c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json') ? await c.req.json() : null;
    } catch {
      raw = null;
    }
    if (raw === null) return json(c, 400, { error: 'invalid_request' });
    const out = await answerQuestion({ labels, wiki: deps.wiki, model: deps.model, usage, caps, maxQuestionChars: config.ASK_MAX_QUESTION_CHARS }, s.user, raw);
    return json(c, out.status, out.body);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
