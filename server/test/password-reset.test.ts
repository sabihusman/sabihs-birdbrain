import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESET_LINK_TTL_SECONDS } from '../src/password-reset.js';
import { ADMIN, ORIGIN, approveByEmail, bearer, buildTestApp, get, post, signUpAndLogin, type TestApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new password';

afterEach(() => vi.useRealTimers());

function tokenFrom(t: TestApp, email: string): string {
  const m = t.mailer.last(email)?.text.match(/#\/reset-password\?token=([A-Za-z0-9_%-]+)/);
  if (!m) throw new Error('no reset link in mail');
  return decodeURIComponent(m[1]);
}

const forgot = (t: TestApp, email: string) => post(t.app, '/v1/auth/forgot-password', { email });
const reset = (t: TestApp, token: string, newPassword = NEW_PASSWORD) => post(t.app, '/v1/auth/reset-password', { token, newPassword });
const login = (t: TestApp, email: string, password: string) => post(t.app, '/v1/auth/login', { email, password });

describe('Forgot password and the reset link (DECISIONS.md #78)', () => {
  it('mails a one-use link to an account; the same answer for an unknown address, which gets nothing', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const token1 = await signUpAndLogin(t, 'sam@example.com');
    t.mailer.sent.length = 0;
    const known = await forgot(t, 'sam@example.com');
    const unknown = await forgot(t, 'nobody@example.com');
    expect([known.status, unknown.status]).toEqual([200, 200]);
    expect(await known.json()).toEqual(await unknown.json());
    expect(t.mailer.sent.map((m) => m.to)).toEqual(['sam@example.com']);
    const mail = t.mailer.sent[0];
    expect(mail.subject).toBe('Choose a new Birdbrain password');
    expect(mail.text).toContain(`${ORIGIN}/#/reset-password?token=`);
    expect(mail.text).toContain('It works once, for 60 minutes');
    expect(mail.text).toContain('Your password stays the same until you use the link.');

    // Asking changes nothing.
    expect((await get(t.app, '/v1/me', bearer(token1))).status).toBe(200);

    const token = tokenFrom(t, 'sam@example.com');
    expect((await reset(t, token)).status).toBe(200);
    // Signed out everywhere, old password dead, new one works, notice mailed.
    expect((await get(t.app, '/v1/me', bearer(token1))).status).toBe(401);
    expect((await login(t, 'sam@example.com', PASSWORD)).status).toBe(401);
    expect((await login(t, 'sam@example.com', NEW_PASSWORD)).status).toBe(200);
    const notice = t.mailer.sent.find((m) => m.subject === 'Your Birdbrain password was changed');
    expect(notice?.text).toContain('you were signed out on every device');
    // One use only.
    expect([(await reset(t, token, 'yet another password')).status]).toEqual([400]);
    expect((await login(t, 'sam@example.com', 'yet another password')).status).toBe(401);
  });

  it('a link stops working after an hour', async () => {
    const t = await buildTestApp();
    await signUpAndLogin(t, 'sam@example.com');
    await forgot(t, 'sam@example.com');
    const token = tokenFrom(t, 'sam@example.com');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + (RESET_LINK_TTL_SECONDS + 60) * 1000);
    const res = await reset(t, token);
    expect([res.status, await res.json()]).toEqual([400, { error: 'invalid_token' }]);
  });

  it('a made-up or tampered token, or a short password, is refused and nothing changes', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    await signUpAndLogin(t, 'sam@example.com');
    await forgot(t, 'sam@example.com');
    const token = tokenFrom(t, 'sam@example.com');
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect([(await reset(t, flipped)).status, (await reset(t, 'x'.repeat(32))).status]).toEqual([400, 400]);
    expect((await reset(t, token, '1234567')).status).toBe(400); // 7 characters
    expect((await reset(t, 'short')).status).toBe(400);
    expect((await login(t, 'sam@example.com', PASSWORD)).status).toBe(200);
    expect((await reset(t, token)).status).toBe(200); // the real token was not used up by the failures
  });

  it('stores the token hashed, so the database alone cannot reset a password', async () => {
    const t = await buildTestApp();
    await signUpAndLogin(t, 'sam@example.com');
    await forgot(t, 'sam@example.com');
    const token = tokenFrom(t, 'sam@example.com');
    const rows = t.db!.prepare('SELECT identifier FROM verification').all() as Array<{ identifier: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).not.toContain(token);
  });

  it('sends nothing to a disabled account, with the same answer', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const admin = await signUpAndLogin(t, ADMIN);
    await signUpAndLogin(t, 'gone@example.com');
    const id = await approveByEmail(t, admin, 'gone@example.com');
    await post(t.app, `/v1/admin/users/${id}/disable`, {}, bearer(admin));
    t.mailer.sent.length = 0;
    const res = await forgot(t, 'gone@example.com');
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect(t.mailer.sent).toEqual([]);
  });

  it('answers the same when the mail fails, and is rate-limited per address', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 2 } });
    await signUpAndLogin(t, 'sam@example.com', PASSWORD); // uses 1 of 2 for this address
    t.mailer.send = async () => {
      throw new Error('smtp down');
    };
    const res = await forgot(t, 'sam@example.com');
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
    expect((await forgot(t, 'sam@example.com')).status).toBe(429);
  });
});
