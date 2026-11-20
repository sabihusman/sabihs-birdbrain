import { describe, expect, it } from 'vitest';
import { needsSignInCode } from '../src/app.js';
import { ADMIN, approvedMember, bearer, buildTestApp, codeFrom, get, post, signUpAndLogin } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

/** Sabih, Nov 20 (DECISIONS.md #129): the emailed code stays at sign-up and for the admin; members sign in with a password. */
describe('sign-in code', () => {
  it('a verified member gets a session straight away, and no mail', async () => {
    const t = await buildTestApp();
    const admin = await signUpAndLogin(t, ADMIN);
    await approvedMember(t, admin, 'sam@example.com');
    t.mailer.sent.length = 0;
    const res = await post(t.app, '/v1/auth/login', { email: 'sam@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; challenge?: string; user?: { email: string; status: string } };
    expect(body.challenge).toBeUndefined();
    expect(body.user).toMatchObject({ email: 'sam@example.com', status: 'approved' });
    expect(t.mailer.sent).toHaveLength(0);
    expect((await get(t.app, '/v1/me', bearer(body.token!))).status).toBe(200);
  });

  it('the admin always gets the code, and no session until it is entered', async () => {
    const t = await buildTestApp();
    await signUpAndLogin(t, ADMIN);
    t.mailer.sent.length = 0;
    const res = await post(t.app, '/v1/auth/login', { email: ADMIN, password: PASSWORD });
    const body = (await res.json()) as { token?: string; challenge?: string };
    expect(body.token).toBeUndefined();
    expect(body.challenge).toBeTruthy();
    const ve = await post(t.app, '/v1/auth/verify', { challenge: body.challenge, code: codeFrom(t.mailer, ADMIN) });
    expect(ve.status).toBe(200);
    expect(((await ve.json()) as { user: { role: string } }).user.role).toBe('admin');
  });

  it('an address never proven (signed up, code never entered) still gets the code at sign-in', async () => {
    const t = await buildTestApp();
    await post(t.app, '/v1/auth/signup', { email: 'new@example.com', password: PASSWORD });
    t.mailer.sent.length = 0;
    const body = (await (await post(t.app, '/v1/auth/login', { email: 'new@example.com', password: PASSWORD })).json()) as { token?: string; challenge?: string };
    expect(body.token).toBeUndefined();
    expect(body.challenge).toBeTruthy();
    expect(t.mailer.sent.map((m) => m.to)).toEqual(['new@example.com']);
  });

  it('a wrong password is still refused, and a disabled account still cannot sign in', async () => {
    const t = await buildTestApp();
    const admin = await signUpAndLogin(t, ADMIN);
    const sam = await approvedMember(t, admin, 'sam@example.com');
    expect((await post(t.app, '/v1/auth/login', { email: 'sam@example.com', password: 'not the password at all' })).status).toBe(401);
    await post(t.app, `/v1/admin/users/${sam.id}/disable`, {}, bearer(admin));
    expect((await post(t.app, '/v1/auth/login', { email: 'sam@example.com', password: PASSWORD })).status).toBe(403);
  });

  it('needsSignInCode: admin or unverified only', () => {
    expect(needsSignInCode({ role: 'admin', emailVerified: true })).toBe(true);
    expect(needsSignInCode({ role: 'member', emailVerified: false })).toBe(true);
    expect(needsSignInCode({ role: 'member', emailVerified: true })).toBe(false);
  });
});
