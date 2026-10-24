import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVITE_TTL_DAYS } from '../src/friends.js';
import { ADMIN, approvedMember, bearer, buildTestApp, get, post, signUpAndLogin, type TestApp } from './helpers.js';

const INVITE_SENT = { ok: true, message: 'Invite sent', newAccount: false };
const INVITE_NEW = { ok: true, newAccount: true };
const PASSWORD = 'correct horse battery staple';

interface FriendsList {
  friends: Array<{ id: string; name: string; since: number }>;
  invites: Array<{ id: string; fromName: string; createdAt: number; expiresAt: number }>;
}
interface FriendsSpecies {
  friends: Array<{ id: string; displayName: string; species: Array<{ sci: string; lastSeen: string }> }>;
}

async function setup(limits: Parameters<typeof buildTestApp>[0]['limits'] = {}) {
  const t = await buildTestApp({ limits: { ipPerWindow: 10_000, emailPerWindow: 10_000, ...limits } });
  const admin = await signUpAndLogin(t, ADMIN);
  const alex = await approvedMember(t, admin, 'alex@example.com');
  const sam = await approvedMember(t, admin, 'sam@example.com');
  await post(t.app, '/v1/me/name', { name: 'Alex' }, bearer(alex.token));
  await post(t.app, '/v1/me/name', { name: 'Sam' }, bearer(sam.token));
  return { t, admin, alex, sam };
}

const listOf = async (t: TestApp, token: string) => (await (await get(t.app, '/v1/friends', bearer(token))).json()) as FriendsList;
const speciesOf = async (t: TestApp, token: string) => (await (await get(t.app, '/v1/friends/species', bearer(token))).json()) as FriendsSpecies;
const inviteMails = (t: TestApp, to: string) => t.mailer.sent.filter((m) => m.to === to && /friend invite/i.test(m.subject));

/** Alex invites Sam and Sam accepts. */
async function befriend(t: TestApp, alex: { token: string }, sam: { token: string }): Promise<void> {
  expect((await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex.token))).status).toBe(200);
  const inv = (await listOf(t, sam.token)).invites[0];
  expect(inv).toBeDefined();
  expect((await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(sam.token))).status).toBe(200);
}

afterEach(() => vi.useRealTimers());

describe('display name', () => {
  it('sets a trimmed name, shows it on /v1/me and refuses bad names', async () => {
    const t = await buildTestApp();
    const token = await signUpAndLogin(t, 'name@example.com');
    const before = (await (await get(t.app, '/v1/me', bearer(token))).json()) as { user: { name: string } };
    expect(before.user.name).toBe('name'); // local part at signup
    const res = await post(t.app, '/v1/me/name', { name: '  Alex Birder  ' }, bearer(token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { name: string } }).user.name).toBe('Alex Birder');
    const after = (await (await get(t.app, '/v1/me', bearer(token))).json()) as { user: { name: string } };
    expect(after.user.name).toBe('Alex Birder');
    for (const name of ['', '   ', 'x'.repeat(41), 'a\u0000b', 'line\nbreak', 'tab\there', 'bidi\u202Eevil', 'zero\u200Bwidth', 42 as unknown as string]) {
      expect((await post(t.app, '/v1/me/name', { name }, bearer(token))).status, JSON.stringify(name)).toBe(400);
    }
    expect((await post(t.app, '/v1/me/name', { name: 'ok', extra: 1 }, bearer(token))).status).toBe(400);
    expect((await post(t.app, '/v1/me/name', { name: 'ok' })).status).toBe(401);
    // unchanged by the refused calls; 40 characters and non-Latin letters are fine
    expect(((await (await get(t.app, '/v1/me', bearer(token))).json()) as { user: { name: string } }).user.name).toBe('Alex Birder');
    expect((await post(t.app, '/v1/me/name', { name: 'Ærø Søren 鳥 ' + 'x'.repeat(28) }, bearer(token))).status).toBe(200);
  });
});

describe('invites', () => {
  it('always answers "Invite sent" and mails only an approved, uninvited, non-friend account', async () => {
    const { t, alex, sam } = await setup();
    await signUpAndLogin(t, 'pending@example.com'); // exists but not approved
    const bodies: unknown[] = [];
    const send = async (email: string) => {
      const res = await post(t.app, '/v1/friends/invite', { email }, bearer(alex.token));
      expect(res.status).toBe(200);
      bodies.push(await res.json());
    };
    await send('sam@example.com'); // approved: mailed
    await send('alex@example.com'); // self: nothing
    await send('pending@example.com'); // not approved: nothing
    await send('SAM@example.com'); // open invite already: nothing more
    expect(inviteMails(t, 'sam@example.com')).toHaveLength(1);
    expect(inviteMails(t, 'alex@example.com')).toHaveLength(0);
    expect(inviteMails(t, 'pending@example.com')).toHaveLength(0);
    for (const b of bodies) expect(b).toEqual(INVITE_SENT);
    // No account: a different answer and a Create account link instead (DECISIONS.md #80).
    const fresh = await post(t.app, '/v1/friends/invite', { email: 'nobody@example.com' }, bearer(alex.token));
    expect(await fresh.json()).toMatchObject(INVITE_NEW);
    expect(t.mailer.last('nobody@example.com')?.subject).toBe('An invite to Sabih’s Birdbrain');
    const mail = inviteMails(t, 'sam@example.com')[0];
    expect(mail.text).toContain('Alex invited you');
    expect(mail.text).toContain('My account');
    expect(mail.text).not.toContain('alex@example.com'); // no third-party address, only the display name
    expect(mail.text).not.toContain('sam@example.com');
    expect(mail.text).toContain('#/account'); // My account (DECISIONS.md #79)
    // the invitee sees it with the inviter's display name only
    const list = await listOf(t, sam.token);
    expect(list.invites).toHaveLength(1);
    expect(list.invites[0]).toMatchObject({ fromName: 'Alex' });
    expect(Object.keys(list.invites[0]).sort()).toEqual(['createdAt', 'expiresAt', 'fromName', 'id']);
    expect(list.friends).toEqual([]);
    // the inviter sees nothing (an outgoing list would reveal which addresses exist)
    expect(await listOf(t, alex.token)).toEqual({ friends: [], invites: [] });
  });

  it('caps invites per user per UTC day, counting every attempt, and resets the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T23:00:00Z'));
    const { t, alex } = await setup({ invitesPerDay: 2 });
    expect((await post(t.app, '/v1/friends/invite', { email: 'nobody1@example.com' }, bearer(alex.token))).status).toBe(200);
    expect((await post(t.app, '/v1/friends/invite', { email: 'nobody2@example.com' }, bearer(alex.token))).status).toBe(200);
    const third = await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex.token));
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: 'rate_limited' });
    expect(inviteMails(t, 'sam@example.com')).toHaveLength(0);
    vi.setSystemTime(new Date('2026-10-20T00:00:01Z'));
    expect((await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex.token))).status).toBe(200);
    expect(inviteMails(t, 'sam@example.com')).toHaveLength(1);
  });

  it('accept makes friends on both sides; decline hides the invite and blocks a repeat until it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
    const { t, alex, sam } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex.token));
    const inv = (await listOf(t, sam.token)).invites[0];
    expect((await post(t.app, `/v1/friends/invites/${inv.id}/decline`, {}, bearer(sam.token))).status).toBe(200);
    expect((await listOf(t, sam.token)).invites).toEqual([]);
    expect((await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(sam.token))).status).toBe(404); // declined: gone
    // a repeat invite sends nothing while the declined one is unexpired, but still answers the same
    const again = await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex.token));
    expect(await again.json()).toEqual(INVITE_SENT);
    expect(inviteMails(t, 'sam@example.com')).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + (INVITE_TTL_DAYS + 1) * 86_400_000));
    // sessions expired with the clock jump (24 h TTL): sign in again
    const alex2 = { token: await signUpAndLogin(t, 'alex@example.com') };
    const sam2 = { token: await signUpAndLogin(t, 'sam@example.com') };
    await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex2.token));
    expect(inviteMails(t, 'sam@example.com')).toHaveLength(2);
    const inv2 = (await listOf(t, sam2.token)).invites[0];
    expect(inv2.id).not.toBe(inv.id);
    expect((await post(t.app, `/v1/friends/invites/${inv2.id}/accept`, {}, bearer(sam2.token))).status).toBe(200);
    expect((await listOf(t, sam2.token)).friends.map((f) => f.name)).toEqual(['Alex']);
    expect((await listOf(t, alex2.token)).friends.map((f) => f.name)).toEqual(['Sam']);
    expect((await listOf(t, sam2.token)).invites).toEqual([]);
    // accepting twice is a 404, and so is a second invite between friends
    expect((await post(t.app, `/v1/friends/invites/${inv2.id}/accept`, {}, bearer(sam2.token))).status).toBe(404);
    await post(t.app, '/v1/friends/invite', { email: 'alex@example.com' }, bearer(sam2.token));
    expect(inviteMails(t, 'alex@example.com')).toHaveLength(0);
  });

  it('an invite expires after 30 days: no longer listed, cannot be accepted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
    const { t, alex, sam } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex.token));
    const inv = (await listOf(t, sam.token)).invites[0];
    expect(inv.expiresAt - inv.createdAt).toBe(INVITE_TTL_DAYS * 86_400_000);
    vi.setSystemTime(new Date('2026-11-19T08:00:01Z'));
    const samLater = await signUpAndLogin(t, 'sam@example.com');
    const alexLater = await signUpAndLogin(t, 'alex@example.com');
    expect((await listOf(t, samLater)).invites).toEqual([]);
    expect((await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(samLater))).status).toBe(404);
    expect((await listOf(t, alexLater)).friends).toEqual([]);
  });

  it('remove works from either side and hides the lists at once', async () => {
    const { t, alex, sam } = await setup();
    await befriend(t, alex, sam);
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }] }, bearer(sam.token));
    expect((await speciesOf(t, alex.token)).friends).toHaveLength(1);
    const samId = (await listOf(t, alex.token)).friends[0].id;
    expect((await post(t.app, `/v1/friends/${samId}/remove`, {}, bearer(alex.token))).status).toBe(200);
    expect((await listOf(t, alex.token)).friends).toEqual([]);
    expect((await listOf(t, sam.token)).friends).toEqual([]);
    expect((await speciesOf(t, alex.token)).friends).toEqual([]);
    expect((await speciesOf(t, sam.token)).friends).toEqual([]);
    // they can become friends again
    await befriend(t, alex, sam);
    expect((await speciesOf(t, alex.token)).friends[0].species).toEqual([{ sci: 'Turdus merula', lastSeen: '2026-10-12' }]);
  });
});

describe('shared species list', () => {
  it('upload replaces the whole set; friends see display name and (sci, lastSeen) only; clear and empty upload remove it', async () => {
    const { t, alex, sam } = await setup();
    await befriend(t, alex, sam);
    const up = await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Parus major', lastSeen: '2026-09-01' }] }, bearer(sam.token));
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ ok: true, count: 2 });
    let seen = await speciesOf(t, alex.token);
    expect(seen.friends).toEqual([{ id: sam.id, displayName: 'Sam', species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Parus major', lastSeen: '2026-09-01' }] }]);
    // newer date for one species, the other dropped: the set is replaced, never merged
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-18' }] }, bearer(sam.token));
    seen = await speciesOf(t, alex.token);
    expect(seen.friends[0].species).toEqual([{ sci: 'Turdus merula', lastSeen: '2026-10-18' }]);
    // Sam sees Alex (no list yet) but never their own list
    expect((await speciesOf(t, sam.token)).friends).toEqual([{ id: alex.id, displayName: 'Alex', species: [] }]);
    expect((await post(t.app, '/v1/me/species/clear', {}, bearer(sam.token))).status).toBe(200);
    expect((await speciesOf(t, alex.token)).friends[0].species).toEqual([]);
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Parus major', lastSeen: '2026-09-01' }] }, bearer(sam.token));
    await post(t.app, '/v1/me/species', { species: [] }, bearer(sam.token));
    expect((await speciesOf(t, alex.token)).friends[0].species).toEqual([]);
  });

  it('validates the upload: known species, real calendar days, no duplicates, strict shape, 2,000 cap', async () => {
    const { t, sam } = await setup();
    const bad = async (body: unknown, code: string) => {
      const res = await post(t.app, '/v1/me/species', body, bearer(sam.token));
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await res.json()).toEqual({ error: code });
    };
    await bad({ species: [{ sci: 'Dog', lastSeen: '2026-10-12' }] }, 'unknown_species'); // non-bird label: not a species
    await bad({ species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Turdus nope', lastSeen: '2026-10-12' }] }, 'unknown_species');
    await bad({ species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Turdus merula', lastSeen: '2026-10-11' }] }, 'invalid_request');
    for (const lastSeen of ['2026-10-12T10:00:00Z', '2026-13-01', '2026-02-30', '12-10-2026', '1999-01-01', '2026-10-1', '', 20261012]) {
      await bad({ species: [{ sci: 'Turdus merula', lastSeen }] }, 'invalid_request');
    }
    await bad({ species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12', count: 3 }] }, 'invalid_request'); // no counts
    await bad({ species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12', lat: 1 }] }, 'invalid_request'); // no locations
    await bad({ species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }], extra: true }, 'invalid_request');
    await bad({ species: 'Turdus merula' }, 'invalid_request');
    await bad({}, 'invalid_request');
    await bad({ species: Array.from({ length: 2001 }, (_, i) => ({ sci: `Turdus merula ${i}`, lastSeen: '2026-10-12' })) }, 'invalid_request');
    // nothing was stored by any refused call, and the leap day is a real day
    expect((await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2024-02-29' }] }, bearer(sam.token))).status).toBe(200);
  });

  it('a large but valid list fits the raised body limit on this route only', async () => {
    const { t, sam } = await setup();
    const many = Array.from({ length: 1500 }, (_, i) => ({ sci: i % 2 ? 'Turdus merula' : 'Parus major', lastSeen: '2026-10-12' }));
    const dup = await post(t.app, '/v1/me/species', { species: many }, bearer(sam.token));
    expect(dup.status).toBe(400); // duplicates, but it got past the body limit (≈ 70 KB)
    const padded = { name: 'x'.repeat(20 * 1024) };
    expect((await post(t.app, '/v1/me/name', padded, bearer(sam.token))).status).toBe(413);
    const huge = { species: Array.from({ length: 2000 }, () => ({ sci: 'x'.repeat(80), lastSeen: '2026-10-12' })), pad: 'y'.repeat(100 * 1024) };
    expect((await post(t.app, '/v1/me/species', huge, bearer(sam.token))).status).toBe(413);
  });
});

describe('account deletion', () => {
  it('removes the user, credentials, sessions, shared list, friendships and invites in one go', async () => {
    const { t, admin, alex, sam } = await setup();
    const riley = await approvedMember(t, admin, 'riley@example.com');
    await befriend(t, alex, sam);
    await post(t.app, '/v1/friends/invite', { email: 'riley@example.com' }, bearer(sam.token)); // pending invite from Sam
    await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(riley.token)); // nothing (open invite), still fine
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }] }, bearer(sam.token));
    await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What?' }, bearer(sam.token));
    const token2 = await signUpAndLogin(t, 'sam@example.com'); // a second session
    const del = await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }, bearer(sam.token));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect((await get(t.app, '/v1/me', bearer(sam.token))).status).toBe(401);
    expect((await get(t.app, '/v1/me', bearer(token2))).status).toBe(401);
    expect((await post(t.app, '/v1/auth/login', { email: 'sam@example.com', password: PASSWORD })).status).toBe(401);
    expect((await listOf(t, alex.token)).friends).toEqual([]);
    expect((await speciesOf(t, alex.token)).friends).toEqual([]);
    expect((await listOf(t, riley.token)).invites).toEqual([]);
    const users = (await (await get(t.app, '/v1/admin/users', bearer(admin))).json()) as { users: Array<{ email: string }> };
    expect(users.users.map((u) => u.email)).not.toContain('sam@example.com');
    // the address is free again and starts over as a pending account
    const again = await signUpAndLogin(t, 'sam@example.com');
    expect(((await (await get(t.app, '/v1/me', bearer(again))).json()) as { user: { status: string } }).user.status).toBe('pending');
  });

  it('needs a session, the password and the word DELETE, and never deletes the admin account', async () => {
    const { t, admin } = await setup();
    expect((await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' })).status).toBe(401);
    const pending = await signUpAndLogin(t, 'pending@example.com');
    expect((await post(t.app, '/v1/me/delete', { confirm: true }, bearer(pending))).status).toBe(400);
    expect((await get(t.app, '/v1/me', bearer(pending))).status).toBe(200);
    const res = await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }, bearer(admin));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'admin_account' });
    expect((await get(t.app, '/v1/me', bearer(admin))).status).toBe(200);
    // a pending (unapproved) user may delete their own account
    expect((await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }, bearer(pending))).status).toBe(200);
    expect((await get(t.app, '/v1/me', bearer(pending))).status).toBe(401);
  });
});

describe('sharing per friend (DECISIONS.md #79)', () => {
  const upload = (t: TestApp, token: string, species: Array<{ sci: string; lastSeen: string }>) => post(t.app, '/v1/me/species', { species }, bearer(token));

  it('both directions share by default; turning it off for one friend hides only my list from them, and back on restores it', async () => {
    const { t, alex, sam } = await setup();
    await befriend(t, alex, sam);
    expect((await upload(t, alex.token, [{ sci: 'Turdus merula', lastSeen: '2026-10-20' }])).status).toBe(200);
    expect((await upload(t, sam.token, [{ sci: 'Parus major', lastSeen: '2026-10-21' }])).status).toBe(200);
    expect((await listOf(t, alex.token)).friends).toEqual([expect.objectContaining({ name: 'Sam', sharing: true })]);
    expect((await speciesOf(t, sam.token)).friends.map((f) => f.displayName)).toEqual(['Alex']);

    // Alex stops sharing with Sam: Sam no longer sees Alex's list; Alex still sees Sam's.
    const off = await post(t.app, `/v1/friends/${sam.id}/share`, { on: false }, bearer(alex.token));
    expect([off.status, await off.json()]).toEqual([200, { ok: true, sharing: false }]);
    expect((await speciesOf(t, sam.token)).friends).toEqual([]);
    expect((await speciesOf(t, alex.token)).friends).toEqual([{ id: sam.id, displayName: 'Sam', species: [{ sci: 'Parus major', lastSeen: '2026-10-21' }] }]);
    expect((await listOf(t, alex.token)).friends[0].sharing).toBe(false);
    expect((await listOf(t, sam.token)).friends[0].sharing).toBe(true); // Sam's own direction is untouched
    // Still friends both ways.
    expect((await listOf(t, sam.token)).friends.map((f) => f.name)).toEqual(['Alex']);

    expect((await post(t.app, `/v1/friends/${sam.id}/share`, { on: true }, bearer(alex.token))).status).toBe(200);
    expect((await speciesOf(t, sam.token)).friends.map((f) => f.displayName)).toEqual(['Alex']);
  });

  it('refuses non-friends, bad bodies and non-members', async () => {
    const { t, admin, alex, sam } = await setup();
    expect((await post(t.app, `/v1/friends/${sam.id}/share`, { on: false }, bearer(alex.token))).status).toBe(404);
    await befriend(t, alex, sam);
    for (const body of [{}, { on: 'no' }, { on: false, extra: 1 }]) expect((await post(t.app, `/v1/friends/${sam.id}/share`, body, bearer(alex.token))).status).toBe(400);
    const pending = await signUpAndLogin(t, 'pending@example.com');
    expect((await post(t.app, `/v1/friends/${sam.id}/share`, { on: false }, bearer(pending))).status).toBe(403);
    expect((await post(t.app, `/v1/friends/${sam.id}/share`, { on: false })).status).toBe(401);
    expect((await speciesOf(t, admin)).friends).toEqual([]);
  });

  it('a database from before keeps every friendship sharing both ways', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { openDatabase } = await import('../src/db.js');
    const path = join(mkdtempSync(join(tmpdir(), 'bb-friends-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE friendship (user_a TEXT NOT NULL, user_b TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (user_a, user_b))');
    old.prepare('INSERT INTO friendship VALUES (?, ?, ?)').run('a', 'b', 1);
    old.close();
    const db = openDatabase(path);
    expect(db.prepare('SELECT user_a, user_b, a_shares, b_shares FROM friendship').all()).toEqual([{ user_a: 'a', user_b: 'b', a_shares: 1, b_shares: 1 }]);
    openDatabase(path).close(); // opening again changes nothing
    db.close();
  });
});
