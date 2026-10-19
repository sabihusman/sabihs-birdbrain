import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { APIError } from 'better-auth/api';
import { answerQuestion, type AnswerModel, type CapConfig } from './ask.js';
import { publicUser, toAppUser, type AppUser, type Auth, type UserStatus } from './auth.js';
import type { Config } from './config.js';
import { createProviderUsageStore, PROVIDER_SUMMARY_DAYS, type ProviderUsageStore } from './provider-usage.js';
import { createAnswerCache, type AnswerCache } from './answer-cache.js';
import type { AnswerBody } from './ask.js';
import { COST_SUMMARY_DAYS, createAskCostStore, type AskCostStore } from './ask-cost.js';
import { createUsageStore } from './db.js';
import { FriendsStore, INVITES_PER_DAY, INVITE_TTL_DAYS, MAX_SHARED_SPECIES, isCalendarDay } from './friends.js';
import { clientIp, emailSchema, passwordSchema, readJson } from './http.js';
import type { SpeciesLabels } from './labels.js';
import { LoginChallenges } from './login-codes.js';
import { MailError, type Mailer } from './mailer.js';
import { RateLimiter } from './rate-limit.js';
import { SignupNotifier } from './signup-notify.js';
import { Users } from './users.js';
import type { WikiFetcher } from './wiki.js';
import type { ArticleFetcher } from './wiki-article.js';
import type { EbirdSource } from './ebird.js';
import type { NatureServeFetcher } from './natureserve.js';

export interface AppDeps {
  config: Config;
  db: DatabaseSync;
  auth: Auth;
  mailer: Mailer;
  labels: SpeciesLabels;
  wiki: WikiFetcher;
  /** Full-article context (cached); the summary is the fallback. */
  article?: ArticleFetcher;
  /** NatureServe status (cached); optional. */
  natureserve?: NatureServeFetcher;
  /** eBird sightings (cached); null when EBIRD_API_KEY is not set. */
  ebird?: EbirdSource | null;
  model: AnswerModel | null;
  /** Daily ask cost totals; main.ts shares one store with createGeminiModel. Created here when absent. */
  costs?: AskCostStore;
  /** Per-provider daily totals (DECISIONS.md #49); main.ts shares one store with the provider chain. Created here when absent. */
  providerUsage?: ProviderUsageStore;
  /** Answer cache; created here when absent. */
  answers?: AnswerCache<AnswerBody>;
  /** Override limits in tests. */
  limits?: { ipPerWindow?: number; emailPerWindow?: number; windowMs?: number; askPerMinute?: number; signupNotifyWindowMs?: number; invitesPerDay?: number };
  /** Clock for the sign-up notifier (tests). */
  now?: () => number;
}

export const BODY_LIMIT_BYTES = 16 * 1024;
/** The shared species list is the one body that can be large: 2,000 entries of ~60 bytes. */
export const SPECIES_BODY_LIMIT_BYTES = 256 * 1024;
const SPECIES_UPLOAD_PATH = '/v1/me/species';

const signupSchema = z.object({ email: emailSchema, password: passwordSchema, name: z.string().trim().max(80).optional() }).strict();
const loginSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
const verifySchema = z.object({ challenge: z.string().min(16).max(64), code: z.string().regex(/^\d{6}$/) }).strict();
const idParam = z.string().min(1).max(64);
/** Display name: trimmed, 1–40 characters, no control or format characters (bidi overrides, zero-width marks). */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), 'control characters are not allowed');
const nameSchema = z.object({ name: displayNameSchema }).strict();
const inviteSchema = z.object({ email: emailSchema }).strict();
const sharedSpeciesSchema = z
  .object({
    species: z.array(z.object({ sci: z.string().min(1).max(80), lastSeen: z.string().length(10).refine(isCalendarDay, 'not a calendar day') }).strict()).max(MAX_SHARED_SPECIES),
  })
  .strict();
const emptySchema = z.object({}).strict();

const json = (c: Context, status: 200 | 400 | 401 | 403 | 404 | 413 | 429 | 500 | 502 | 503, body: unknown) => c.json(body, status);

export function createApp(deps: AppDeps) {
  const { config, db, auth, mailer, labels } = deps;
  const users = new Users(db);
  const challenges = new LoginChallenges(db, config.BETTER_AUTH_SECRET, config.LOGIN_CODE_TTL_SECONDS);
  const usage = createUsageStore(db);
  const costs = deps.costs ?? createAskCostStore(db);
  const providerUsage = deps.providerUsage ?? createProviderUsageStore(db);
  const answers = deps.answers ?? createAnswerCache<AnswerBody>(db);
  const friends = new FriendsStore(db);
  const invitesPerDay = deps.limits?.invitesPerDay ?? INVITES_PER_DAY;
  const caps: CapConfig = { perUserDaily: config.ASK_DAILY_PER_USER, globalDaily: config.ASK_DAILY_GLOBAL };
  const windowMs = deps.limits?.windowMs ?? 10 * 60 * 1000;
  const authByIp = new RateLimiter(deps.limits?.ipPerWindow ?? 20, windowMs);
  const loginByEmail = new RateLimiter(deps.limits?.emailPerWindow ?? 6, windowMs);
  const askByIp = new RateLimiter(deps.limits?.askPerMinute ?? 10, 60 * 1000);
  // Admin page lives on the first allowed origin (the production front end).
  const signups = new SignupNotifier(mailer, config.adminEmail, `${config.allowedOrigins[0]}/#/admin`, deps.limits?.signupNotifyWindowMs, deps.now);

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
  const tooLarge = (c: Context) => c.json({ error: 'payload_too_large' }, 413);
  const smallBody = bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: tooLarge });
  const speciesBody = bodyLimit({ maxSize: SPECIES_BODY_LIMIT_BYTES, onError: tooLarge });
  app.use('/v1/*', (c, next) => (c.req.path === SPECIES_UPLOAD_PATH ? speciesBody(c, next) : smallBody(c, next)));

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
    const before = users.get(ch.user_id);
    users.markEmailVerified(ch.user_id);
    const user = users.get(ch.user_id);
    const expiresAt = users.sessionExpiry(ch.session_token);
    if (!user || !expiresAt) return json(c, 401, { error: 'invalid_code' });
    // First successful verification of a pending account: tell the admin (rate-limited, address only).
    if (before && !before.emailVerified && user.status === 'pending') await signups.notify(user.email);
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

  app.post('/v1/me/name', async (c) => {
    const s = await sessionUser(c);
    if (!s) return json(c, 401, { error: 'unauthorized' });
    const body = await readJson(c, nameSchema);
    if (!body) return json(c, 400, { error: 'invalid_request' });
    users.setName(s.user.id, body.name);
    return json(c, 200, { ok: true, user: publicUser({ ...s.user, name: body.name }) });
  });

  /**
   * Delete the account and everything it owns, in one transaction (see
   * FriendsStore.deleteUserCompletely). Any signed-in user may delete their own
   * account; the admin account is the exception, since it is the only one that
   * can approve people (sign up again with ADMIN_EMAIL would recreate it, but
   * that is an operational decision, not a tap).
   */
  app.post('/v1/me/delete', async (c) => {
    const s = await sessionUser(c);
    if (!s) return json(c, 401, { error: 'unauthorized' });
    const body = await readJson(c, emptySchema);
    if (!body) return json(c, 400, { error: 'invalid_request' });
    if (s.user.role === 'admin') return json(c, 400, { error: 'admin_account' });
    friends.deleteUserCompletely(s.user.id);
    return json(c, 200, { ok: true });
  });

  // ---- friends (approved members only; DECISIONS.md #44) ---------------------

  /** 401 for no session, 403 `not_approved` for pending/rejected/disabled, else the member. */
  async function requireMember(c: Context): Promise<{ user: AppUser } | { error: Response }> {
    const s = await sessionUser(c);
    if (!s) return { error: json(c, 401, { error: 'unauthorized' }) };
    if (s.user.status !== 'approved') return { error: json(c, 403, { error: 'not_approved' }) };
    return { user: s.user };
  }

  const INVITE_SENT = { ok: true, message: 'Invite sent' };

  /**
   * Always answers "Invite sent" (and 429 only for the caller's own daily cap,
   * which counts every attempt). A mail goes out only when an approved account
   * with that address exists, is not the caller, is not already a friend and
   * has no open invite with the caller; the body is identical either way.
   */
  app.post('/v1/friends/invite', async (c) => {
    const m = await requireMember(c);
    if ('error' in m) return m.error;
    const body = await readJson(c, inviteSchema);
    if (!body) return json(c, 400, { error: 'invalid_request' });
    const now = Date.now();
    if (friends.invitesToday(m.user.id, now) >= invitesPerDay) return json(c, 429, { error: 'rate_limited' });
    friends.recordInviteAttempt(m.user.id, now);
    friends.purgeExpired(now);
    const target = users.getByEmail(body.email);
    const sendable = target && target.id !== m.user.id && target.status === 'approved' && !friends.areFriends(m.user.id, target.id) && !friends.openInviteBetween(m.user.id, target.id, now);
    if (sendable) {
      friends.createInvite(m.user.id, target.id, now);
      try {
        await mailer.send({
          to: target.email,
          subject: 'A friend invite on Birdbrain',
          text: `${m.user.name} invited you to be friends on Sabih’s Birdbrain.\n\nOpen the Account card on the Settings tab to accept or decline: ${config.allowedOrigins[0]}/#/settings\n\nFriends can share which birds they have spotted and the date they last spotted each one, and nothing else, and only if they turn sharing on. The invite expires in ${INVITE_TTL_DAYS} days. If you do not know this person, ignore this message.`,
        });
      } catch (err) {
        // The invite is stored and shows up in the app; the mail is only a nudge.
        console.error(`[error] invite mail failed: ${describeMailError(err)}`);
      }
    }
    return json(c, 200, INVITE_SENT);
  });

  app.get('/v1/friends', async (c) => {
    const m = await requireMember(c);
    if ('error' in m) return m.error;
    const now = Date.now();
    friends.purgeExpired(now);
    return json(c, 200, { friends: friends.friendsOf(m.user.id), invites: friends.incomingInvites(m.user.id, now) });
  });

  app.post('/v1/friends/invites/:id/:action', async (c) => {
    const m = await requireMember(c);
    if ('error' in m) return m.error;
    const id = idParam.safeParse(c.req.param('id'));
    const action = c.req.param('action');
    if (!id.success || (action !== 'accept' && action !== 'decline')) return json(c, 400, { error: 'invalid_request' });
    const ok = action === 'accept' ? friends.accept(id.data, m.user.id) : friends.decline(id.data, m.user.id);
    if (!ok) return json(c, 404, { error: 'not_found' });
    return json(c, 200, { ok: true });
  });

  /** Idempotent: 200 whether or not the pair was friends, so ids cannot be probed. */
  app.post('/v1/friends/:id/remove', async (c) => {
    const m = await requireMember(c);
    if ('error' in m) return m.error;
    const id = idParam.safeParse(c.req.param('id'));
    if (!id.success) return json(c, 400, { error: 'invalid_request' });
    friends.removeFriend(m.user.id, id.data);
    return json(c, 200, { ok: true });
  });

  /** Each accepted friend's display name and (scientific name, last-seen day) pairs; nothing else. */
  app.get('/v1/friends/species', async (c) => {
    const m = await requireMember(c);
    if ('error' in m) return m.error;
    return json(c, 200, { friends: friends.friendsSpecies(m.user.id) });
  });

  /** The full current list replaces the stored one; unknown scientific names are refused outright. */
  app.post(SPECIES_UPLOAD_PATH, async (c) => {
    const m = await requireMember(c);
    if ('error' in m) return m.error;
    const body = await readJson(c, sharedSpeciesSchema);
    if (!body) return json(c, 400, { error: 'invalid_request' });
    if (body.species.some((s) => !labels.has(s.sci))) return json(c, 400, { error: 'unknown_species' });
    const seen = new Set<string>();
    for (const s of body.species) {
      if (seen.has(s.sci)) return json(c, 400, { error: 'invalid_request' });
      seen.add(s.sci);
    }
    friends.replaceSharedSpecies(m.user.id, body.species);
    return json(c, 200, { ok: true, count: body.species.length });
  });

  app.post('/v1/me/species/clear', async (c) => {
    const m = await requireMember(c);
    if ('error' in m) return m.error;
    friends.clearSharedSpecies(m.user.id);
    return json(c, 200, { ok: true });
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

  /** Per-day token and cost totals for /v1/ask (DECISIONS.md #48): numbers only, no questions. */
  app.get('/v1/admin/ask-costs', async (c) => {
    if (!(await requireAdmin(c))) return json(c, 403, { error: 'forbidden' });
    return json(c, 200, {
      model: config.GEMINI_MODEL,
      days: costs.summary(COST_SUMMARY_DAYS),
      // Which provider answered (DECISIONS.md #49): one row per provider over the same window, with the configured model names.
      providerOrder: config.providerOrder,
      models: { ollama: config.OLLAMA_MODEL, gemini: config.GEMINI_MODEL },
      providers: providerUsage.totals(PROVIDER_SUMMARY_DAYS),
    });
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
    const out = await answerQuestion({ labels, wiki: deps.wiki, article: deps.article, natureserve: deps.natureserve, ebird: deps.ebird ?? null, model: deps.model, usage, caps, maxQuestionChars: config.ASK_MAX_QUESTION_CHARS, answers, costs, log: (line) => console.info(line) }, s.user, raw);
    return json(c, out.status, out.body);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
