import { describe, expect, it } from 'vitest';
import { ADMIN, approvedMember, bearer, buildTestApp, get, post, signUpAndLogin, type TestApp } from './helpers.js';

/**
 * Adversarial probes for the friends feature (DECISIONS.md #43): who can read
 * whose species list, what a friend can see, and whether any answer or mail
 * reveals which addresses have accounts.
 */

interface FriendsSpecies {
  friends: Array<{ id: string; displayName: string; species: Array<{ sci: string; lastSeen: string }> }>;
}
interface FriendsList {
  friends: Array<{ id: string; name: string }>;
  invites: Array<{ id: string; fromName: string }>;
}

const listOf = async (t: TestApp, token: string) => (await (await get(t.app, '/v1/friends', bearer(token))).json()) as FriendsList;
const speciesOf = async (t: TestApp, token: string) => (await (await get(t.app, '/v1/friends/species', bearer(token))).json()) as FriendsSpecies;
const TARGET_LIST = [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Parus major', lastSeen: '2026-10-01' }];

async function world() {
  const t = await buildTestApp({ limits: { ipPerWindow: 10_000, emailPerWindow: 10_000 } });
  const admin = await signUpAndLogin(t, ADMIN);
  const target = await approvedMember(t, admin, 'target@example.com');
  await post(t.app, '/v1/me/name', { name: 'Target' }, bearer(target.token));
  expect((await post(t.app, '/v1/me/species', { species: TARGET_LIST }, bearer(target.token))).status).toBe(200);
  return { t, admin, target };
}

/** Every entry of the species answer that belongs to the target. */
const targetEntry = (res: FriendsSpecies, targetId: string) => res.friends.find((f) => f.id === targetId);

describe('adversarial: who can read a shared species list', () => {
  it('a stranger, a pending invitee, a declined invitee, a removed former friend and a signed-out caller all see nothing', async () => {
    const { t, admin, target } = await world();
    // stranger: approved member with no relationship
    const stranger = await approvedMember(t, admin, 'stranger@example.com');
    expect((await speciesOf(t, stranger.token)).friends).toEqual([]);
    // pending invitee: the target invited them, they have not accepted
    const invitee = await approvedMember(t, admin, 'invitee@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'invitee@example.com' }, bearer(target.token));
    expect((await listOf(t, invitee.token)).invites).toHaveLength(1);
    expect((await speciesOf(t, invitee.token)).friends).toEqual([]);
    // the other way round too: an invite the stranger sent to the target, unanswered, grants nothing
    await post(t.app, '/v1/friends/invite', { email: 'target@example.com' }, bearer(stranger.token));
    expect((await speciesOf(t, stranger.token)).friends).toEqual([]);
    // declined invitee
    const decliner = await approvedMember(t, admin, 'decliner@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'decliner@example.com' }, bearer(target.token));
    const inv = (await listOf(t, decliner.token)).invites[0];
    expect((await post(t.app, `/v1/friends/invites/${inv.id}/decline`, {}, bearer(decliner.token))).status).toBe(200);
    expect((await speciesOf(t, decliner.token)).friends).toEqual([]);
    // removed former friend: accepted once, then removed by the target
    const former = await approvedMember(t, admin, 'former@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'former@example.com' }, bearer(target.token));
    const inv2 = (await listOf(t, former.token)).invites[0];
    await post(t.app, `/v1/friends/invites/${inv2.id}/accept`, {}, bearer(former.token));
    expect(targetEntry(await speciesOf(t, former.token), target.id)?.species).toEqual(TARGET_LIST);
    await post(t.app, `/v1/friends/${former.id}/remove`, {}, bearer(target.token));
    expect((await speciesOf(t, former.token)).friends).toEqual([]);
    // signed out: 401 and no body beyond the code
    const anon = await get(t.app, '/v1/friends/species');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: 'unauthorized' });
    // a token that was logged out
    await post(t.app, '/v1/auth/logout', {}, bearer(stranger.token));
    expect((await get(t.app, '/v1/friends/species', bearer(stranger.token))).status).toBe(401);
  });

  it('a friend sees exactly the display name and (sci, lastSeen) pairs, nothing else, and never their own list', async () => {
    const { t, admin, target } = await world();
    const friend = await approvedMember(t, admin, 'friend@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'friend@example.com' }, bearer(target.token));
    const inv = (await listOf(t, friend.token)).invites[0];
    await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(friend.token));
    const res = await get(t.app, '/v1/friends/species', bearer(friend.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as FriendsSpecies;
    expect(Object.keys(body)).toEqual(['friends']);
    expect(body.friends).toHaveLength(1);
    const entry = body.friends[0];
    expect(Object.keys(entry).sort()).toEqual(['displayName', 'id', 'species']);
    expect(entry.displayName).toBe('Target');
    for (const s of entry.species) expect(Object.keys(s).sort()).toEqual(['lastSeen', 'sci']);
    expect(entry.species).toEqual(TARGET_LIST);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/@/); // no address anywhere
    expect(text).not.toMatch(/T\d\d:\d\d/); // no times
    expect(text).not.toMatch(/lat|lon|count|hits|confidence|clip|recording/i);
    // the friend list endpoint is as sparse: id, name, since, and whether I share with them (DECISIONS.md #79)
    const list = await listOf(t, friend.token);
    expect(Object.keys(list.friends[0]).sort()).toEqual(['id', 'name', 'sharing', 'since']);
    expect(JSON.stringify(list)).not.toMatch(/@/);
  });

  it('pending, rejected and disabled users get 403 or 401 on every friend endpoint, and a disabled friend’s list disappears', async () => {
    const { t, admin, target } = await world();
    const pending = await signUpAndLogin(t, 'pending@example.com');
    const deny = async (token: string, status: number) => {
      expect((await get(t.app, '/v1/friends', bearer(token))).status).toBe(status);
      expect((await get(t.app, '/v1/friends/species', bearer(token))).status).toBe(status);
      expect((await post(t.app, '/v1/friends/invite', { email: 'target@example.com' }, bearer(token))).status).toBe(status);
      expect((await post(t.app, '/v1/friends/invites/x/accept', {}, bearer(token))).status).toBe(status);
      expect((await post(t.app, `/v1/friends/${target.id}/remove`, {}, bearer(token))).status).toBe(status);
      expect((await post(t.app, '/v1/me/species', { species: TARGET_LIST }, bearer(token))).status).toBe(status);
      expect((await post(t.app, '/v1/me/species/clear', {}, bearer(token))).status).toBe(status);
    };
    await deny(pending, 403);
    expect(await (await get(t.app, '/v1/friends', bearer(pending))).json()).toEqual({ error: 'not_approved' });
    expect(t.mailer.sent.filter((m) => m.to === 'target@example.com' && /invite/i.test(m.subject))).toHaveLength(0);
    // an approved friend who then gets disabled: sessions die, and their list vanishes from the target's view
    const friend = await approvedMember(t, admin, 'friend@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'friend@example.com' }, bearer(target.token));
    const inv = (await listOf(t, friend.token)).invites[0];
    await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(friend.token));
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Parus major', lastSeen: '2026-10-02' }] }, bearer(friend.token));
    expect((await speciesOf(t, target.token)).friends).toHaveLength(1);
    await post(t.app, `/v1/admin/users/${friend.id}/disable`, {}, bearer(admin));
    await deny(friend.token, 401);
    expect((await speciesOf(t, target.token)).friends).toEqual([]);
    expect((await listOf(t, target.token)).friends).toEqual([]);
  });
});

describe('adversarial: enumeration and probing', () => {
  it('among addresses with an account the invite answer is byte-identical; an address without one is told so (DECISIONS.md #80)', async () => {
    const { t, admin, target } = await world();
    const friend = await approvedMember(t, admin, 'friend@example.com');
    await signUpAndLogin(t, 'pending@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'friend@example.com' }, bearer(target.token));
    const inv = (await listOf(t, friend.token)).invites[0];
    await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(friend.token));
    await approvedMember(t, admin, 'exists@example.com');
    await approvedMember(t, admin, 'invited@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'invited@example.com' }, bearer(target.token));
    // Existing: approved, own, pending, already a friend, already invited, the admin.
    const answers: string[] = [];
    for (const email of ['exists@example.com', 'target@example.com', 'pending@example.com', 'friend@example.com', 'invited@example.com', ADMIN]) {
      const res = await post(t.app, '/v1/friends/invite', { email }, bearer(target.token));
      answers.push(`${res.status} ${await res.text()}`);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe('200 {"ok":true,"message":"Invite sent","newAccount":false}');
    // Sabih's choice: an address without an account is told apart, so the sender knows a Create account link went out.
    const missing = await post(t.app, '/v1/friends/invite', { email: 'missing@example.com' }, bearer(target.token));
    expect(await missing.json()).toMatchObject({ ok: true, newAccount: true });
    // mails went only where an invite could be delivered; none of them names any address
    const invites = t.mailer.sent.filter((m) => /friend invite/i.test(m.subject));
    expect(invites.map((m) => m.to).sort()).toEqual(['exists@example.com', 'friend@example.com', 'invited@example.com', ADMIN].sort());
    for (const m of invites) expect(m.text).not.toMatch(/@/);
    // the cap counts every attempt alike, so a probe cannot tell a delivered invite from a dropped one by its budget
    const capped = await buildTestApp({ limits: { ipPerWindow: 10_000, emailPerWindow: 10_000, invitesPerDay: 3 } });
    const a2 = await signUpAndLogin(capped, ADMIN);
    const m2 = await approvedMember(capped, a2, 'm@example.com');
    const statuses: number[] = [];
    for (const email of ['missing1@example.com', ADMIN, 'missing2@example.com', 'missing3@example.com', ADMIN]) statuses.push((await post(capped.app, '/v1/friends/invite', { email }, bearer(m2.token))).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('invite ids cannot be acted on by anyone but the invitee, and unknown ids look the same as foreign ones', async () => {
    const { t, admin, target } = await world();
    const invitee = await approvedMember(t, admin, 'invitee@example.com');
    const mallory = await approvedMember(t, admin, 'mallory@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'invitee@example.com' }, bearer(target.token));
    const inv = (await listOf(t, invitee.token)).invites[0];
    const foreign = await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(mallory.token));
    const unknown = await post(t.app, `/v1/friends/invites/${'z'.repeat(22)}/accept`, {}, bearer(mallory.token));
    const own = await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(target.token)); // the sender cannot accept for the invitee
    expect([foreign.status, unknown.status, own.status]).toEqual([404, 404, 404]);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect((await speciesOf(t, mallory.token)).friends).toEqual([]);
    expect((await listOf(t, target.token)).friends).toEqual([]);
    // malformed ids and actions
    expect((await post(t.app, `/v1/friends/invites/${'x'.repeat(65)}/accept`, {}, bearer(invitee.token))).status).toBe(400);
    expect((await post(t.app, `/v1/friends/invites/${inv.id}/approve`, {}, bearer(invitee.token))).status).toBe(400);
    // the invite is still intact for the rightful invitee
    expect((await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(invitee.token))).status).toBe(200);
  });

  it('remove answers 200 for friends, strangers and unknown ids alike, and only touches the caller’s own pair', async () => {
    const { t, admin, target } = await world();
    const friend = await approvedMember(t, admin, 'friend@example.com');
    const mallory = await approvedMember(t, admin, 'mallory@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'friend@example.com' }, bearer(target.token));
    const inv = (await listOf(t, friend.token)).invites[0];
    await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(friend.token));
    // Mallory "removes" the target: nothing happens to the target–friend pair
    expect((await post(t.app, `/v1/friends/${target.id}/remove`, {}, bearer(mallory.token))).status).toBe(200);
    expect((await post(t.app, `/v1/friends/${'nope'}/remove`, {}, bearer(mallory.token))).status).toBe(200);
    expect(targetEntry(await speciesOf(t, friend.token), target.id)?.species).toEqual(TARGET_LIST);
    expect((await listOf(t, target.token)).friends.map((f) => f.id)).toEqual([friend.id]);
  });

  it('the shared list cannot be written for someone else, and a stranger’s upload never shows up anywhere', async () => {
    const { t, admin, target } = await world();
    const mallory = await approvedMember(t, admin, 'mallory@example.com');
    // no user id in the body is accepted
    expect((await post(t.app, '/v1/me/species', { userId: target.id, species: [] }, bearer(mallory.token))).status).toBe(400);
    expect((await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12', userId: target.id }] }, bearer(mallory.token))).status).toBe(400);
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }] }, bearer(mallory.token));
    // the target's own list is untouched and Mallory's is invisible to the target
    expect((await speciesOf(t, target.token)).friends).toEqual([]);
    const friend = await approvedMember(t, admin, 'friend@example.com');
    await post(t.app, '/v1/friends/invite', { email: 'friend@example.com' }, bearer(target.token));
    const inv = (await listOf(t, friend.token)).invites[0];
    await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(friend.token));
    expect(targetEntry(await speciesOf(t, friend.token), target.id)?.species).toEqual(TARGET_LIST);
  });

  it('a display name cannot smuggle mail headers, markup is stored as text, and the mail carries no address', async () => {
    const { t, admin, target } = await world();
    const friend = await approvedMember(t, admin, 'friend@example.com');
    expect((await post(t.app, '/v1/me/name', { name: 'Evil\r\nBcc: x@y.z' }, bearer(target.token))).status).toBe(400);
    expect((await post(t.app, '/v1/me/name', { name: '<b>Bold</b> name' }, bearer(target.token))).status).toBe(200);
    await post(t.app, '/v1/friends/invite', { email: 'friend@example.com' }, bearer(target.token));
    const mail = t.mailer.sent.filter((m) => m.to === 'friend@example.com' && /friend invite/i.test(m.subject))[0];
    expect(mail.text).toContain('<b>Bold</b> name invited you');
    expect(mail.text).not.toMatch(/@/);
    expect(mail.subject).not.toMatch(/Bold/); // the name never reaches the subject line
    expect((await listOf(t, friend.token)).invites[0].fromName).toBe('<b>Bold</b> name');
  });
});
