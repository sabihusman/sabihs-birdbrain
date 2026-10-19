import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { createAuth, migrateAuth } from '../src/auth.js';
import { openDatabase } from '../src/db.js';
import { FakeMailer } from '../src/mailer.js';
import { ADMIN, approvedMember, bearer, get, LABELS, post, signUpAndLogin, testConfig, type TestApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';

/** Like buildTestApp, but hands the database back so tests can look at every table. */
async function setup() {
  const config = testConfig();
  const db = openDatabase(':memory:');
  await migrateAuth(db, config);
  const auth = createAuth(db, config);
  const mailer = new FakeMailer();
  const wiki = async (sci: string) => ({ title: sci, extract: `${sci} is a bird. It eats seeds.`, url: `https://en.wikipedia.org/wiki/${sci}` });
  const app = createApp({ config, db, auth, mailer, labels: LABELS, wiki, model: async () => 'A plain answer from the source text.' });
  const t: TestApp = { app, mailer, config, modelCalls: [] };
  const admin = await signUpAndLogin(t, ADMIN);
  return { t, db, admin };
}

/** Every (table, column) pair whose value equals the id or address, plus the ask counter scope. */
function rowsReferencing(db: DatabaseSync, userId: string, email: string): string[] {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
  const hits: string[] = [];
  for (const table of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of cols) {
      const n = db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE "${col}" = ? OR lower("${col}") = lower(?) OR "${col}" = ?`).get(userId, email, `user:${userId}`) as { n: number };
      if (Number(n.n) > 0) hits.push(`${table}.${col}=${n.n}`);
    }
  }
  return hits;
}

async function befriend(t: TestApp, a: { token: string }, b: { token: string; email: string }) {
  await post(t.app, '/v1/friends/invite', { email: b.email }, bearer(a.token));
  const inv = ((await (await get(t.app, '/v1/friends', bearer(b.token))).json()) as { invites: Array<{ id: string }> }).invites[0];
  await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(b.token));
}

describe('account deletion', () => {
  it('removes every row keyed to the user, in every table, and mails a confirmation', async () => {
    const { t, db, admin } = await setup();
    const sam = { ...(await approvedMember(t, admin, 'sam@example.com')), email: 'sam@example.com' };
    const alex = { ...(await approvedMember(t, admin, 'alex@example.com')), email: 'alex@example.com' };
    const riley = { ...(await approvedMember(t, admin, 'riley@example.com')), email: 'riley@example.com' };
    await befriend(t, alex, sam);
    await post(t.app, '/v1/friends/invite', { email: riley.email }, bearer(sam.token)); // pending, from Sam
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }] }, bearer(sam.token));
    await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What?' }, bearer(sam.token));
    await post(t.app, '/v1/auth/login', { email: sam.email, password: PASSWORD }); // an unverified challenge
    const token2 = await signUpAndLogin(t, sam.email); // a second session
    const before = rowsReferencing(db, sam.id, sam.email);
    for (const key of ['user.id', 'account.userId', 'session.userId', 'shared_species.user_id', 'friendship', 'friend_invite.from_user_id', 'invite_usage.user_id', 'ask_usage.scope', 'login_challenge.user_id']) {
      expect(before.join(' ')).toContain(key);
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verification'").get()).toBeDefined();

    t.mailer.sent.length = 0;
    const del = await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }, bearer(sam.token));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(rowsReferencing(db, sam.id, sam.email)).toEqual([]);

    // both tokens are dead, the password no longer signs in
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(401);
    expect((await get(t.app, '/v1/me', bearer(token2))).status).toBe(401);
    expect((await get(t.app, '/v1/friends/species', bearer(sam.token))).status).toBe(401);
    expect((await post(t.app, '/v1/auth/login', { email: sam.email, password: PASSWORD })).status).toBe(401);
    // former friend and invitee no longer see Sam anywhere
    expect(((await (await get(t.app, '/v1/friends', bearer(alex.token))).json()) as { friends: unknown[] }).friends).toEqual([]);
    expect(((await (await get(t.app, '/v1/friends/species', bearer(alex.token))).json()) as { friends: unknown[] }).friends).toEqual([]);
    expect(((await (await get(t.app, '/v1/friends', bearer(riley.token))).json()) as { invites: unknown[] }).invites).toEqual([]);
    // the others are untouched
    expect(rowsReferencing(db, alex.id, alex.email).length).toBeGreaterThan(0);
    // one short confirmation mail to the address, with no secrets in it
    const mail = t.mailer.sent.filter((m) => m.to === sam.email);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe('Your Birdbrain account was deleted');
    expect(mail[0].text).toContain('permanently');
    expect(mail[0].text).toContain('keeps no backups');
    expect(mail[0].text).not.toContain(PASSWORD);
    expect(mail[0].text).not.toContain(sam.id);
  });

  it('a wrong password or a wrong confirmation word changes nothing', async () => {
    const { t, db, admin } = await setup();
    const sam = await approvedMember(t, admin, 'sam@example.com');
    const snapshot = rowsReferencing(db, sam.id, 'sam@example.com');
    const cases: Array<[unknown, string]> = [
      [{ password: 'not the password', confirm: 'DELETE' }, 'wrong_password'],
      [{ password: PASSWORD, confirm: 'delete' }, 'confirm_mismatch'],
      [{ password: PASSWORD, confirm: 'DELETE ' }, 'confirm_mismatch'],
      [{ password: PASSWORD }, 'invalid_request'],
      [{ confirm: 'DELETE' }, 'invalid_request'],
      [{}, 'invalid_request'],
      [{ password: PASSWORD, confirm: 'DELETE', extra: 1 }, 'invalid_request'],
    ];
    for (const [body, code] of cases) {
      const res = await post(t.app, '/v1/me/delete', body, bearer(sam.token));
      expect([res.status, await res.json()]).toEqual([400, { error: code }]);
    }
    expect(t.mailer.sent.filter((m) => m.subject.includes('deleted'))).toEqual([]);
    expect(rowsReferencing(db, sam.id, 'sam@example.com')).toEqual(snapshot);
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(200);
    expect((await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' })).status).toBe(401);
  });

  it('the admin account cannot delete itself, even with the right password and word', async () => {
    const { t, db, admin } = await setup();
    const res = await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }, bearer(admin));
    expect([res.status, await res.json()]).toEqual([400, { error: 'admin_account' }]);
    expect((await get(t.app, '/v1/me', bearer(admin))).status).toBe(200);
    expect(rowsReferencing(db, 'none', ADMIN).length).toBeGreaterThan(0);
    expect(t.mailer.sent.filter((m) => m.subject.includes('deleted'))).toEqual([]);
  });

  it('a pending account may delete itself, and the mail failing does not change the answer', async () => {
    const { t, db, admin } = await setup();
    void admin;
    const token = await signUpAndLogin(t, 'pending@example.com');
    t.mailer.send = async () => {
      throw new Error('smtp down');
    };
    const res = await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }, bearer(token));
    expect(res.status).toBe(200);
    expect(rowsReferencing(db, 'none', 'pending@example.com')).toEqual([]);
    expect((await get(t.app, '/v1/me', bearer(token))).status).toBe(401);
  });
});
