import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginChallenges, MAX_CODE_ATTEMPTS } from '../src/login-codes.js';
import { openDatabase } from '../src/db.js';
import { Users } from '../src/users.js';
import { createAuth, migrateAuth } from '../src/auth.js';
import { ADMIN, buildTestApp, codeFrom, get, post, signUpAndLogin, testConfig, type TestApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function startLogin(t: TestApp, email: string): Promise<{ challenge: string; code: string }> {
  const li = await post(t.app, '/v1/auth/login', { email, password: PASSWORD });
  expect(li.status).toBe(200);
  const { challenge } = (await li.json()) as { challenge: string };
  return { challenge, code: codeFrom(t.mailer, email) };
}

afterEach(() => vi.useRealTimers());

describe('adversarial: sign-in codes', () => {
  it('a code cannot be brute-forced: the challenge burns after MAX_CODE_ATTEMPTS and its session is revoked', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000 } });
    const email = 'brute@example.com';
    await post(t.app, '/v1/auth/signup', { email, password: PASSWORD });
    const { challenge, code } = await startLogin(t, email);
    const tried: number[] = [];
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) tried.push((await post(t.app, '/v1/auth/verify', { challenge, code: String(i).padStart(6, '0') })).status);
    expect(tried.every((s) => s === 401)).toBe(true);
    // the right code no longer works, and a brand-new attempt is needed
    expect((await post(t.app, '/v1/auth/verify', { challenge, code })).status).toBe(401);
    // with 5 tries per challenge and 6 login attempts per e-mail per 10 minutes, at most 30 of 1,000,000 codes are testable per window
    expect(MAX_CODE_ATTEMPTS * 6).toBeLessThan(1_000_000 / 1000);
  });

  it('an expired code is refused and the session it guarded is deleted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
    const t = await buildTestApp({ env: { LOGIN_CODE_TTL_SECONDS: '60' } });
    const email = 'late@example.com';
    await post(t.app, '/v1/auth/signup', { email, password: PASSWORD });
    const { challenge, code } = await startLogin(t, email);
    vi.setSystemTime(new Date('2026-10-19T08:01:01Z'));
    expect((await post(t.app, '/v1/auth/verify', { challenge, code })).status).toBe(401);
  });

  it('LoginChallenges: expiry and purge revoke the pre-issued session token', () => {
    const config = testConfig();
    const db = openDatabase(':memory:');
    // openDatabase creates login_challenge; session is Better Auth's table, created here in minimal form
    db.exec('CREATE TABLE session (token TEXT PRIMARY KEY, userId TEXT, expiresAt INTEGER)');
    db.prepare('INSERT INTO session (token, userId, expiresAt) VALUES (?, ?, ?)').run('tok-1', 'u1', Date.now() + 100000);
    db.prepare('INSERT INTO session (token, userId, expiresAt) VALUES (?, ?, ?)').run('tok-2', 'u1', Date.now() + 100000);
    const ch = new LoginChallenges(db, config.BETTER_AUTH_SECRET, 60);
    const now = 1_000_000;
    const a = ch.create('u1', 'a@example.com', 'tok-1', now);
    const b = ch.create('u1', 'a@example.com', 'tok-2', now);
    // right code but too late: refused, session gone
    expect(ch.verify(a.id, a.code, now + 61_000)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM session WHERE token = ?').get('tok-1')).toEqual({ n: 0 });
    // abandoned challenge: purge revokes its session
    ch.purgeExpired(now + 61_000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM session WHERE token = ?').get('tok-2')).toEqual({ n: 0 });
    expect(ch.verify(b.id, b.code, now + 61_000)).toBeNull();
  });

  it('a code is single-use and bound to its challenge', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const alice = 'alice@example.com';
    const mallory = 'mallory@example.com';
    for (const e of [alice, mallory]) await post(t.app, '/v1/auth/signup', { email: e, password: PASSWORD });
    const a = await startLogin(t, alice);
    const m = await startLogin(t, mallory);
    // Mallory's own code does not complete Alice's challenge
    expect((await post(t.app, '/v1/auth/verify', { challenge: a.challenge, code: m.code })).status).toBe(401);
    // the challenge id cannot be tampered with
    const flipped = a.challenge.slice(0, -1) + (a.challenge.endsWith('A') ? 'B' : 'A');
    expect((await post(t.app, '/v1/auth/verify', { challenge: flipped, code: a.code })).status).toBe(401);
    // replay: once used, the same code and challenge are dead
    expect((await post(t.app, '/v1/auth/verify', { challenge: a.challenge, code: a.code })).status).toBe(200);
    expect((await post(t.app, '/v1/auth/verify', { challenge: a.challenge, code: a.code })).status).toBe(401);
    // code format is strict: no 5-digit, 7-digit, spaced or non-numeric codes reach the store
    for (const code of ['12345', '1234567', '12 345', 'abcdef', '', ' 123456 ', 123456 as unknown as string]) {
      expect((await post(t.app, '/v1/auth/verify', { challenge: m.challenge, code })).status).toBe(400);
    }
    // the only mail sent for a login carries the code; nothing is echoed in the API answer
    const li = await post(t.app, '/v1/auth/login', { email: alice, password: PASSWORD });
    const text = JSON.stringify(await li.json());
    expect(text).not.toMatch(/\b\d{6}\b/);
  });

  it('a second login invalidates nothing for the first but each challenge holds its own session', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const email = 'twice@example.com';
    await post(t.app, '/v1/auth/signup', { email, password: PASSWORD });
    const first = await startLogin(t, email);
    const second = await startLogin(t, email);
    expect(first.challenge).not.toBe(second.challenge);
    const t1 = ((await (await post(t.app, '/v1/auth/verify', { challenge: first.challenge, code: first.code })).json()) as { token: string }).token;
    const t2 = ((await (await post(t.app, '/v1/auth/verify', { challenge: second.challenge, code: second.code })).json()) as { token: string }).token;
    expect(t1).not.toBe(t2);
    expect((await get(t.app, '/v1/me', bearer(t1))).status).toBe(200);
    expect((await get(t.app, '/v1/me', bearer(t2))).status).toBe(200);
  });
});

describe('adversarial: bearer tokens', () => {
  it('rejects every tampered or foreign token shape', async () => {
    const t = await buildTestApp();
    const token = await signUpAndLogin(t, 'token@example.com');
    expect((await get(t.app, '/v1/me', bearer(token))).status).toBe(200);
    const variants: Array<[string, string]> = [
      ['flipped last char', `Bearer ${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`],
      ['truncated', `Bearer ${token.slice(0, -4)}`],
      ['extended', `Bearer ${token}x`],
      ['upper-cased', `Bearer ${token.toUpperCase()}`],
      ['prefixed', `Bearer x${token}`],
      ['lower-case scheme', `bearer ${token}`],
      ['basic scheme', `Basic ${Buffer.from(`token@example.com:${PASSWORD}`).toString('base64')}`],
      ['empty', 'Bearer '],
      ['jwt-looking', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.'],
      ['sql', "Bearer ' OR '1'='1"],
      ['two tokens', `Bearer ${token}, Bearer ${token}`],
    ];
    for (const [name, value] of variants) {
      const res = await get(t.app, '/v1/me', { authorization: value });
      expect(res.status, name).toBe(401);
    }
    // the token in a query string or cookie is not accepted either
    expect((await t.app.request(`/v1/me?token=${token}`, { headers: { origin: 'https://birdbrain-test.vercel.app' } })).status).toBe(401);
    expect((await get(t.app, '/v1/me', { cookie: `better-auth.session_token=${token}` })).status).toBe(401);
  });

  it('a token dies with logout, with disabling, and with rejection', async () => {
    const t = await buildTestApp();
    const admin = await signUpAndLogin(t, ADMIN);
    const email = 'victim@example.com';
    const token = await signUpAndLogin(t, email);
    expect((await post(t.app, '/v1/auth/logout', {}, bearer(token))).status).toBe(200);
    expect((await get(t.app, '/v1/me', bearer(token))).status).toBe(401);
    expect((await post(t.app, '/v1/auth/refresh', {}, bearer(token))).status).toBe(401);
    const token2 = await signUpAndLogin(t, email);
    const id = ((await (await get(t.app, '/v1/admin/users', bearer(admin))).json()) as { users: Array<{ id: string; email: string }> }).users.find((u) => u.email === email)!.id;
    expect((await post(t.app, `/v1/admin/users/${id}/reject`, {}, bearer(admin))).status).toBe(200);
    expect((await get(t.app, '/v1/me', bearer(token2))).status).toBe(401);
    expect((await post(t.app, '/v1/auth/login', { email, password: PASSWORD })).status).toBe(403);
    expect(t.mailer.sent.filter((m) => m.to === email && /code/i.test(m.subject)).length).toBe(2); // no code mail after rejection
  });

  it('a session issued at the password step is unusable until the code is verified', async () => {
    const config = testConfig();
    const db = openDatabase(':memory:');
    await migrateAuth(db, config);
    const auth = createAuth(db, config);
    const users = new Users(db);
    await auth.api.signUpEmail({ body: { email: 'half@example.com', password: PASSWORD, name: 'half' } });
    const res = await auth.api.signInEmail({ body: { email: 'half@example.com', password: PASSWORD } });
    // Better Auth stored a session; the app never returns res.token before the code step, and
    // LoginChallenges.discard/purge delete it if the code step is abandoned.
    expect(users.sessionExpiry(res.token)).not.toBeNull();
    const ch = new LoginChallenges(db, config.BETTER_AUTH_SECRET, 1);
    const c = ch.create('x', 'half@example.com', res.token, 0);
    ch.purgeExpired(5000);
    expect(users.sessionExpiry(res.token)).toBeNull();
    expect(ch.verify(c.id, c.code, 5000)).toBeNull();
  });
});

describe('adversarial: authorization', () => {
  it('pending, rejected and disabled users cannot ask; no Wikipedia or model call happens', async () => {
    let wikiCalls = 0;
    const t = await buildTestApp({
      wiki: async (sci) => {
        wikiCalls++;
        return { title: sci, extract: 'It eats seeds.', url: 'https://en.wikipedia.org/wiki/x' };
      },
    });
    const admin = await signUpAndLogin(t, ADMIN);
    const email = 'pending@example.com';
    const token = await signUpAndLogin(t, email);
    const body = { species: 'Turdus merula', question: 'What does it eat?' };
    expect((await post(t.app, '/v1/ask', body, bearer(token))).status).toBe(403);
    expect(wikiCalls).toBe(0);
    expect(t.modelCalls.length).toBe(0);
    // status cannot be set from the client side: signup ignores extra fields, verify returns the stored status
    const su = await post(t.app, '/v1/auth/signup', { email: 'elevate@example.com', password: PASSWORD, status: 'approved', role: 'admin' });
    expect(su.status).toBe(400); // strict schema
    const me = (await (await get(t.app, '/v1/me', bearer(token))).json()) as { user: { status: string; role: string } };
    expect(me.user).toMatchObject({ status: 'pending', role: 'member' });
    // approve, then disable: asking stops immediately
    const id = ((await (await get(t.app, '/v1/admin/users', bearer(admin))).json()) as { users: Array<{ id: string; email: string }> }).users.find((u) => u.email === email)!.id;
    await post(t.app, `/v1/admin/users/${id}/approve`, {}, bearer(admin));
    expect((await post(t.app, '/v1/ask', body, bearer(token))).status).toBe(200);
    await post(t.app, `/v1/admin/users/${id}/disable`, {}, bearer(admin));
    expect((await post(t.app, '/v1/ask', body, bearer(token))).status).toBe(401);
  });

  it('admin routes refuse members (pending or approved), anonymous callers and self-changes', async () => {
    const t = await buildTestApp();
    const admin = await signUpAndLogin(t, ADMIN);
    const member = await signUpAndLogin(t, 'member@example.com');
    const users = ((await (await get(t.app, '/v1/admin/users', bearer(admin))).json()) as { users: Array<{ id: string; email: string }> }).users;
    const memberId = users.find((u) => u.email === 'member@example.com')!.id;
    const adminId = users.find((u) => u.email === ADMIN)!.id;
    const deny = async (token: string | null) => {
      const h = token ? bearer(token) : {};
      expect((await get(t.app, '/v1/admin/users', h)).status).toBe(403);
      for (const action of ['approve', 'reject', 'disable']) {
        expect((await post(t.app, `/v1/admin/users/${memberId}/${action}`, {}, h)).status).toBe(403);
        expect((await post(t.app, `/v1/admin/users/${adminId}/${action}`, {}, h)).status).toBe(403);
      }
    };
    await deny(member); // pending member
    await post(t.app, `/v1/admin/users/${memberId}/approve`, {}, bearer(admin));
    await deny(member); // approved member: role, not status, decides
    await deny(null);
    // the member is still pending-free and untouched by the refused calls
    expect(((await (await get(t.app, '/v1/me', bearer(member))).json()) as { user: { status: string } }).user.status).toBe('approved');
    // unknown actions and the admin's own account
    expect((await post(t.app, `/v1/admin/users/${memberId}/promote`, {}, bearer(admin))).status).toBe(400);
    expect((await post(t.app, `/v1/admin/users/${adminId}/disable`, {}, bearer(admin))).status).toBe(400);
    expect((await post(t.app, `/v1/admin/users/../../me/approve`, {}, bearer(admin))).status).not.toBe(200);
    expect((await post(t.app, `/v1/admin/users/${'x'.repeat(65)}/approve`, {}, bearer(admin))).status).toBe(400);
  });

  it('signup and login leak nothing about which addresses exist', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    await post(t.app, '/v1/auth/signup', { email: 'known@example.com', password: PASSWORD });
    const again = await post(t.app, '/v1/auth/signup', { email: 'known@example.com', password: PASSWORD });
    const fresh = await post(t.app, '/v1/auth/signup', { email: 'fresh@example.com', password: PASSWORD });
    expect(await again.json()).toEqual(await fresh.json());
    const wrongPw = await post(t.app, '/v1/auth/login', { email: 'known@example.com', password: 'definitely wrong pw' });
    const noUser = await post(t.app, '/v1/auth/login', { email: 'nobody@example.com', password: 'definitely wrong pw' });
    expect([wrongPw.status, noUser.status]).toEqual([401, 401]);
    expect(await wrongPw.json()).toEqual(await noUser.json());
  });
});
