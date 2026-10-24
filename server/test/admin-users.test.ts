import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createAuth, migrateAuth } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { FakeMailer } from '../src/mailer.js';
import { ADMIN, approvedMember, bearer, codeFrom, get, LABELS, post, rowsReferencing, signUpAndLogin, testConfig, type TestApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

async function setup() {
  const config = testConfig();
  const db = openDatabase(':memory:');
  await migrateAuth(db, config);
  const auth = createAuth(db, config);
  const mailer = new FakeMailer();
  const wiki = async (sci: string) => ({ title: sci, extract: `${sci} is a bird.`, url: `https://en.wikipedia.org/wiki/${sci}` });
  // Generous limits: these tests sign in many times from one address.
  const app = createApp({ config, db, auth, mailer, labels: LABELS, wiki, model: async () => 'A plain answer.', limits: { ipPerWindow: 1000, emailPerWindow: 1000 } });
  const t: TestApp = { app, mailer, config, modelCalls: [] };
  const admin = await signUpAndLogin(t, ADMIN);
  const adminId = ((await (await get(t.app, '/v1/me', bearer(admin))).json()) as { user: { id: string } }).user.id;
  return { t, db, admin, adminId };
}

const login = (t: TestApp, email: string, password: string) => post(t.app, '/v1/auth/login', { email, password });

/** The token from the reset link in the latest mail to `email`. */
function tokenFrom(t: TestApp, email: string): string {
  const m = t.mailer.last(email)?.text.match(/#\/reset-password\?token=([A-Za-z0-9_%-]+)/);
  if (!m) throw new Error('no reset link in mail');
  return decodeURIComponent(m[1]);
}

describe('approval stays mandatory', () => {
  it('a new account is pending until the admin approves it, and member endpoints refuse it', async () => {
    const { t, admin } = await setup();
    const token = await signUpAndLogin(t, 'new@example.com');
    const me = (await (await get(t.app, '/v1/me', bearer(token))).json()) as { user: { status: string; role: string } };
    expect(me.user).toMatchObject({ status: 'pending', role: 'member' });
    expect((await get(t.app, '/v1/friends', bearer(token))).status).toBe(403);
    const list = (await (await get(t.app, '/v1/admin/users', bearer(admin))).json()) as { users: Array<{ email: string; status: string }> };
    expect(list.users.find((u) => u.email === 'new@example.com')?.status).toBe('pending');
  });
});

describe('password length', () => {
  it('7 characters are refused at sign-up, 8 are accepted', async () => {
    const { t } = await setup();
    expect((await post(t.app, '/v1/auth/signup', { email: 'seven@example.com', password: '1234567' })).status).toBe(400);
    expect((await post(t.app, '/v1/auth/signup', { email: 'eight@example.com', password: '12345678' })).status).toBe(200);
    expect((await login(t, 'eight@example.com', '12345678')).status).toBe(200);
    // Nothing was created for the 7-character attempt.
    expect((await login(t, 'seven@example.com', '1234567')).status).toBe(400);
    expect((await login(t, 'seven@example.com', '12345678')).status).toBe(401);
  });

  it('a 10+ character password from before keeps working', async () => {
    const { t } = await setup();
    await signUpAndLogin(t, 'old@example.com', 'a-ten-char-password');
    expect((await login(t, 'old@example.com', 'a-ten-char-password')).status).toBe(200);
  });
});

describe('admin reset password (a link, DECISIONS.md #78)', () => {
  it('mails the user a reset link and changes nothing until it is used; then the new password works and every session ends', async () => {
    const { t, admin, db } = await setup();
    const sam = await approvedMember(t, admin, 'sam@example.com');
    const second = await signUpAndLogin(t, 'sam@example.com'); // a second device
    await login(t, 'sam@example.com', PASSWORD); // a half-finished code step
    t.mailer.sent.length = 0;

    const res = await post(t.app, `/v1/admin/users/${sam.id}/reset-password`, {}, bearer(admin));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, emailed: true });

    // Mail went to the user only, once, with a link and no password.
    expect(t.mailer.sent.map((m) => m.to)).toEqual(['sam@example.com']);
    const mail = t.mailer.sent[0];
    expect(mail.subject).toBe('Choose a new Birdbrain password');
    expect(mail.text).toContain('Sabih sent you this link');
    expect(mail.text).toMatch(/https:\/\/birdbrain-test\.vercel\.app\/#\/reset-password\?token=/);
    expect(mail.text).not.toMatch(/password is/i);
    const token = tokenFrom(t, 'sam@example.com');
    expect(JSON.stringify(body)).not.toContain(token);

    // Nothing changed yet: the old password and sessions still work.
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(200);
    expect((await login(t, 'sam@example.com', PASSWORD)).status).toBe(200);

    // The link sets the new password; old sessions and half-finished sign-ins end.
    expect((await post(t.app, '/v1/auth/reset-password', { token, newPassword: 'a brand new password' })).status).toBe(200);
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(401);
    expect((await get(t.app, '/v1/me', bearer(second))).status).toBe(401);
    expect(db.prepare('SELECT count(*) AS n FROM session WHERE userId = ?').get(sam.id)).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM login_challenge WHERE user_id = ?').get(sam.id)).toEqual({ n: 0 });
    expect((await login(t, 'sam@example.com', PASSWORD)).status).toBe(401);
    const li = await login(t, 'sam@example.com', 'a brand new password');
    expect(li.status).toBe(200);
    const { challenge } = (await li.json()) as { challenge: string };
    const ve = await post(t.app, '/v1/auth/verify', { challenge, code: codeFrom(t.mailer, 'sam@example.com') });
    expect(((await ve.json()) as { user: { status: string } }).user.status).toBe('approved');
  });

  it('says emailed: false when the mail fails, and nothing changes', async () => {
    const { t, admin } = await setup();
    const sam = await approvedMember(t, admin, 'sam@example.com');
    t.mailer.send = async () => {
      throw new Error('smtp down');
    };
    const res = await post(t.app, `/v1/admin/users/${sam.id}/reset-password`, {}, bearer(admin));
    expect([res.status, await res.json()]).toEqual([200, { ok: true, emailed: false }]);
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(200);
  });

  it('refuses the admin account, unknown ids, non-admins and anonymous callers', async () => {
    const { t, admin, adminId } = await setup();
    const sam = await approvedMember(t, admin, 'sam@example.com');
    const pending = await signUpAndLogin(t, 'pending@example.com');
    t.mailer.sent.length = 0;

    const self = await post(t.app, `/v1/admin/users/${adminId}/reset-password`, {}, bearer(admin));
    expect([self.status, await self.json()]).toEqual([400, { error: 'own_account' }]);
    expect((await get(t.app, '/v1/me', bearer(admin))).status).toBe(200);
    expect((await post(t.app, '/v1/admin/users/nope/reset-password', {}, bearer(admin))).status).toBe(404);
    for (const token of [sam.token, pending]) {
      const r = await post(t.app, `/v1/admin/users/${adminId}/reset-password`, {}, bearer(token));
      expect([r.status, await r.json()]).toEqual([403, { error: 'forbidden' }]);
    }
    expect((await post(t.app, `/v1/admin/users/${sam.id}/reset-password`, {}, bearer(pending))).status).toBe(403);
    expect((await post(t.app, `/v1/admin/users/${sam.id}/reset-password`, {})).status).toBe(403);
    expect(t.mailer.sent).toEqual([]);
    expect((await login(t, 'sam@example.com', PASSWORD)).status).toBe(200);
  });
});

describe('admin delete user', () => {
  it('wipes every row keyed to the user and mails the confirmation to that user only', async () => {
    const { t, admin, db } = await setup();
    const sam = await approvedMember(t, admin, 'sam@example.com');
    const alex = await approvedMember(t, admin, 'alex@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'alex@example.com' }, bearer(sam.token));
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }] }, bearer(sam.token));
    await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What?' }, bearer(sam.token));
    expect(rowsReferencing(db, sam.id, 'sam@example.com').length).toBeGreaterThan(3);
    t.mailer.sent.length = 0;

    const wrong = await post(t.app, `/v1/admin/users/${sam.id}/delete`, { confirm: 'alex@example.com' }, bearer(admin));
    expect([wrong.status, await wrong.json()]).toEqual([400, { error: 'confirm_mismatch' }]);
    expect((await post(t.app, `/v1/admin/users/${sam.id}/delete`, {}, bearer(admin))).status).toBe(400);
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(200);

    const res = await post(t.app, `/v1/admin/users/${sam.id}/delete`, { confirm: ' Sam@Example.com ' }, bearer(admin));
    expect([res.status, await res.json()]).toEqual([200, { ok: true, emailed: true }]);
    expect(rowsReferencing(db, sam.id, 'sam@example.com')).toEqual([]);
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(401);
    expect((await login(t, 'sam@example.com', PASSWORD)).status).toBe(401);
    expect(t.mailer.sent.map((m) => [m.to, m.subject])).toEqual([['sam@example.com', 'Your Birdbrain account was deleted']]);
    // Alex is untouched and no longer sees the invite.
    expect(rowsReferencing(db, alex.id, 'alex@example.com').length).toBeGreaterThan(0);
    expect(((await (await get(t.app, '/v1/friends', bearer(alex.token))).json()) as { invites: unknown[] }).invites).toEqual([]);
    // Gone from the admin list; a second delete is a 404.
    const list = (await (await get(t.app, '/v1/admin/users', bearer(admin))).json()) as { users: Array<{ email: string }> };
    expect(list.users.map((u) => u.email)).not.toContain('sam@example.com');
    expect((await post(t.app, `/v1/admin/users/${sam.id}/delete`, { confirm: 'sam@example.com' }, bearer(admin))).status).toBe(404);
  });

  it('refuses the admin account itself and non-admin callers', async () => {
    const { t, admin, adminId, db } = await setup();
    const sam = await approvedMember(t, admin, 'sam@example.com');
    const self = await post(t.app, `/v1/admin/users/${adminId}/delete`, { confirm: ADMIN }, bearer(admin));
    expect([self.status, await self.json()]).toEqual([400, { error: 'own_account' }]);
    expect((await get(t.app, '/v1/me', bearer(admin))).status).toBe(200);
    const r = await post(t.app, `/v1/admin/users/${adminId}/delete`, { confirm: ADMIN }, bearer(sam.token));
    expect([r.status, await r.json()]).toEqual([403, { error: 'forbidden' }]);
    expect((await post(t.app, `/v1/admin/users/${sam.id}/delete`, { confirm: 'sam@example.com' })).status).toBe(403);
    expect(rowsReferencing(db, sam.id, 'sam@example.com').length).toBeGreaterThan(0);
    expect(t.mailer.sent.filter((m) => m.subject.includes('deleted'))).toEqual([]);
  });
});

describe('change my password', () => {
  it('needs the current password, keeps this device signed in with a new token, ends the others', async () => {
    const { t, admin } = await setup();
    const sam = await approvedMember(t, admin, 'sam@example.com');
    const other = await signUpAndLogin(t, 'sam@example.com');
    const wrong = await post(t.app, '/v1/me/password', { currentPassword: 'not it at all', newPassword: 'newpass88' }, bearer(sam.token));
    expect([wrong.status, await wrong.json()]).toEqual([400, { error: 'wrong_current_password' }]);
    expect((await post(t.app, '/v1/me/password', { currentPassword: PASSWORD, newPassword: 'short7!' }, bearer(sam.token))).status).toBe(400);
    expect((await post(t.app, '/v1/me/password', { currentPassword: PASSWORD, newPassword: 'newpass88' })).status).toBe(401);
    t.mailer.sent.length = 0;

    const res = await post(t.app, '/v1/me/password', { currentPassword: PASSWORD, newPassword: 'newpass88' }, bearer(sam.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { email: string } };
    expect(body.user.email).toBe('sam@example.com');
    expect(JSON.stringify(body)).not.toContain('newpass88');
    expect((await get(t.app, '/v1/me', bearer(body.token))).status).toBe(200);
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(401);
    expect((await get(t.app, '/v1/me', bearer(other))).status).toBe(401);
    expect((await login(t, 'sam@example.com', PASSWORD)).status).toBe(401);
    expect((await login(t, 'sam@example.com', 'newpass88')).status).toBe(200);
    const notice = t.mailer.sent.filter((m) => m.subject === 'Your Birdbrain password was changed');
    expect(notice.map((m) => m.to)).toEqual(['sam@example.com']);
    expect(notice[0].text).not.toContain('newpass88');
  });
});
