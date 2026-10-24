import { describe, expect, it } from 'vitest';
import { ADMIN, ORIGIN, approveByEmail, bearer, buildTestApp, codeFrom, get, post, signUpAndLogin, type TestApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

async function signup(t: TestApp, email: string, password = PASSWORD, name?: string): Promise<{ status: number; challenge: string }> {
  const res = await post(t.app, '/v1/auth/signup', name === undefined ? { email, password } : { email, password, name });
  const body = res.status === 200 ? ((await res.json()) as { challenge: string }) : { challenge: '' };
  return { status: res.status, challenge: body.challenge };
}

const mailsTo = (t: TestApp, to: string, subject: RegExp) => t.mailer.sent.filter((m) => m.to === to && subject.test(m.subject));

describe('Create account finishes with an emailed code (DECISIONS.md #77)', () => {
  it('a new address: code mail, then pending, a "waiting for approval" mail to the person and a note to the admin', async () => {
    const t = await buildTestApp();
    await signUpAndLogin(t, ADMIN);
    const email = 'new@example.com';
    const su = await signup(t, email, PASSWORD, 'Robin');
    expect(su.status).toBe(200);
    expect(mailsTo(t, email, /^Your Birdbrain code$/)).toHaveLength(1);
    expect(mailsTo(t, email, /waiting for approval/)).toHaveLength(0); // not before the code
    const ve = await post(t.app, '/v1/auth/verify', { challenge: su.challenge, code: codeFrom(t.mailer, email) });
    expect(ve.status).toBe(200);
    const { user } = (await ve.json()) as { user: { status: string; name: string } };
    expect(user).toMatchObject({ status: 'pending', name: 'Robin' });
    const pending = mailsTo(t, email, /waiting for approval/);
    expect(pending).toHaveLength(1);
    expect(pending[0].text).toContain(`${ORIGIN}/#/account`);
    expect(mailsTo(t, ADMIN, /sign-up/)).toHaveLength(1);
    // Signing in again later sends neither again.
    await signUpAndLogin(t, email);
    expect(mailsTo(t, email, /waiting for approval/)).toHaveLength(1);
    expect(mailsTo(t, ADMIN, /sign-up/)).toHaveLength(1);
  });

  it('an account that was created but never confirmed (the old flow) can finish with Create account again', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    await signUpAndLogin(t, ADMIN);
    const email = 'stuck@example.com';
    await signup(t, email); // never verified
    const again = await signup(t, email);
    const ve = await post(t.app, '/v1/auth/verify', { challenge: again.challenge, code: codeFrom(t.mailer, email) });
    expect(ve.status).toBe(200);
    expect(mailsTo(t, email, /waiting for approval/)).toHaveLength(1);
    expect(mailsTo(t, ADMIN, /sign-up/)).toHaveLength(1);
  });

  it('an existing address with its password gets a code, like sign-in; an approved member is not told "waiting"', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const admin = await signUpAndLogin(t, ADMIN);
    const email = 'member@example.com';
    await signUpAndLogin(t, email);
    await approveByEmail(t, admin, email);
    const su = await signup(t, email);
    const ve = await post(t.app, '/v1/auth/verify', { challenge: su.challenge, code: codeFrom(t.mailer, email) });
    expect(ve.status).toBe(200);
    expect(((await ve.json()) as { user: { status: string } }).user.status).toBe('approved');
    expect(mailsTo(t, email, /waiting for approval/)).toHaveLength(1); // only the first time, while pending
  });

  it('an existing address with another password: the owner gets a note without a code and no code works', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const email = 'owner@example.com';
    await signUpAndLogin(t, email);
    const su = await signup(t, email, 'not the owner password');
    expect(su.status).toBe(200);
    const note = t.mailer.last(email)!;
    expect(note.subject).toBe('You already have a Birdbrain account');
    expect(note.text).toContain(`${ORIGIN}/#/signin`);
    expect(note.text).not.toMatch(/\b\d{6}\b/);
    for (const code of ['000000', '123456', '999999']) expect((await post(t.app, '/v1/auth/verify', { challenge: su.challenge, code })).status).toBe(401);
    // the password was not changed and no session was made for the stranger
    expect((await post(t.app, '/v1/auth/login', { email, password: 'not the owner password' })).status).toBe(401);
  });

  it('a disabled account gets the note, never a code, and its sessions stay revoked', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const admin = await signUpAndLogin(t, ADMIN);
    const email = 'gone@example.com';
    await signUpAndLogin(t, email);
    const id = await approveByEmail(t, admin, email);
    expect((await post(t.app, `/v1/admin/users/${id}/disable`, {}, bearer(admin))).status).toBe(200);
    const before = t.mailer.sent.length;
    const su = await signup(t, email);
    expect(su.status).toBe(200);
    expect(t.mailer.sent).toHaveLength(before + 1);
    expect(t.mailer.last(email)!.subject).toBe('You already have a Birdbrain account');
    expect((await post(t.app, '/v1/auth/verify', { challenge: su.challenge, code: '123456' })).status).toBe(401);
  });

  it('the display name is optional (the address before @), and a name with control characters is refused', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
    const token = await signUpAndLogin(t, 'plain@example.com');
    const me = (await (await get(t.app, '/v1/me', bearer(token))).json()) as { user: { name: string } };
    expect(me.user.name).toBe('plain');
    expect((await signup(t, 'evil@example.com', PASSWORD, 'Bob\u202Eevil')).status).toBe(400);
    expect((await signup(t, 'long@example.com', PASSWORD, 'x'.repeat(41))).status).toBe(400);
  });

  it('is rate-limited per address like sign-in', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 2 } });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await signup(t, 'many@example.com')).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});
