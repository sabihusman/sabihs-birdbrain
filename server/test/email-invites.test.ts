import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVITE_TTL_DAYS } from '../src/friends.js';
import { ADMIN, approveByEmail, approvedMember, bearer, buildTestApp, codeFrom, get, ORIGIN, post, signUpAndLogin, type TestApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
afterEach(() => vi.useRealTimers());

interface FriendsSpecies {
  friends: Array<{ id: string; displayName: string; species: Array<{ sci: string; lastSeen: string }> }>;
}
const speciesOf = async (t: TestApp, token: string) => (await (await get(t.app, '/v1/friends/species', bearer(token))).json()) as FriendsSpecies;
const friendsOf = async (t: TestApp, token: string) => ((await (await get(t.app, '/v1/friends', bearer(token))).json()) as { friends: Array<{ name: string; sharing: boolean }> }).friends;

async function setup() {
  const t = await buildTestApp({ limits: { ipPerWindow: 10_000, emailPerWindow: 10_000 } });
  const admin = await signUpAndLogin(t, ADMIN);
  const alex = await approvedMember(t, admin, 'alex@example.com');
  await post(t.app, '/v1/me/name', { name: 'Alex' }, bearer(alex.token));
  await post(t.app, '/v1/me/species', { species: [{ sci: 'Turdus merula', lastSeen: '2026-10-20' }] }, bearer(alex.token));
  return { t, admin, alex };
}

function inviteToken(t: TestApp, email: string): string {
  const m = t.mailer.last(email)?.text.match(/#\/signup\?invite=([A-Za-z0-9_%-]+)/);
  if (!m) throw new Error('no invite link');
  return decodeURIComponent(m[1]);
}

/** Create account through the link, then the code; returns the bearer token. */
async function joinWith(t: TestApp, email: string, invite: string, shareWithInviter: boolean, password = PASSWORD): Promise<string> {
  const su = await post(t.app, '/v1/auth/signup', { email, password, name: 'Robin', invite, shareWithInviter });
  const { challenge } = (await su.json()) as { challenge: string };
  const ve = await post(t.app, '/v1/auth/verify', { challenge, code: codeFrom(t.mailer, email) });
  if (ve.status !== 200) throw new Error(`verify ${ve.status}`);
  return ((await ve.json()) as { token: string }).token;
}

describe('invites to an address with no account (DECISIONS.md #80)', () => {
  it('the link leads to Create account; approval makes them friends, sharing both ways when the box was ticked', async () => {
    const { t, admin, alex } = await setup();
    const res = await post(t.app, '/v1/friends/invite', { email: 'robin@example.com' }, bearer(alex.token));
    expect(await res.json()).toEqual({ ok: true, message: 'They don’t have an account yet, so we emailed them a link to create one. You become friends once Sabih approves it.', newAccount: true });
    const mail = t.mailer.last('robin@example.com')!;
    expect(mail.subject).toBe('An invite to Sabih’s Birdbrain');
    expect(mail.text).toContain('Alex invited you');
    expect(mail.text).toContain(`${ORIGIN}/#/signup?invite=`);
    expect(mail.text).not.toContain('alex@example.com');
    const token = inviteToken(t, 'robin@example.com');

    // The Create account page can show who invited them, and nothing else.
    const info = await post(t.app, '/v1/auth/invite-info', { token });
    expect(info.status).toBe(200);
    const body = (await info.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'fromName']);
    expect(body.fromName).toBe('Alex');

    const robin = await joinWith(t, 'robin@example.com', token, true);
    // Not friends while pending, and the link is used up.
    expect((await post(t.app, '/v1/auth/invite-info', { token })).status).toBe(404);
    t.mailer.sent.length = 0;
    await approveByEmail(t, admin, 'robin@example.com');
    expect(t.mailer.last('robin@example.com')?.text).toContain('You and Alex are now friends on Birdbrain.');
    expect(t.mailer.last('alex@example.com')?.subject).toBe('Your friend joined Birdbrain');
    expect(t.mailer.last('alex@example.com')?.text).toContain('Robin accepted your invite');

    // Both directions share.
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Parus major', lastSeen: '2026-10-22' }] }, bearer(robin));
    expect((await speciesOf(t, robin)).friends.map((f) => f.displayName)).toEqual(['Alex']);
    expect((await speciesOf(t, alex.token)).friends.map((f) => f.displayName)).toEqual(['Robin']);
    expect(await friendsOf(t, robin)).toEqual([expect.objectContaining({ name: 'Alex', sharing: true })]);
  });

  it('without the box ticked, Alex’s list goes to Robin but Robin’s does not go back', async () => {
    const { t, admin, alex } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'robin@example.com' }, bearer(alex.token));
    const robin = await joinWith(t, 'robin@example.com', inviteToken(t, 'robin@example.com'), false);
    await approveByEmail(t, admin, 'robin@example.com');
    await post(t.app, '/v1/me/species', { species: [{ sci: 'Parus major', lastSeen: '2026-10-22' }] }, bearer(robin));
    expect((await speciesOf(t, robin)).friends.map((f) => f.displayName)).toEqual(['Alex']);
    expect((await speciesOf(t, alex.token)).friends).toEqual([]);
    expect(await friendsOf(t, robin)).toEqual([expect.objectContaining({ name: 'Alex', sharing: false })]);
  });

  it('a link works once; a second account using it gets no friendship', async () => {
    const { t, admin, alex } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'robin@example.com' }, bearer(alex.token));
    const token = inviteToken(t, 'robin@example.com');
    await joinWith(t, 'robin@example.com', token, true);
    const other = await joinWith(t, 'other@example.com', token, true);
    await approveByEmail(t, admin, 'robin@example.com');
    await approveByEmail(t, admin, 'other@example.com');
    expect(await friendsOf(t, other)).toEqual([]);
    expect((await friendsOf(t, alex.token)).map((f) => f.name)).toEqual(['Robin']);
  });

  it('an existing member who signs in through a link becomes a friend at once', async () => {
    const { t, admin, alex } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'robin@other.example' }, bearer(alex.token));
    const token = inviteToken(t, 'robin@other.example');
    await approvedMember(t, admin, 'member@example.com');
    const member = await joinWith(t, 'member@example.com', token, false);
    expect((await friendsOf(t, member)).map((f) => f.name)).toEqual(['Alex']);
  });

  it('a wrong password for an existing address claims nothing', async () => {
    const { t, admin, alex } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'robin@example.com' }, bearer(alex.token));
    const token = inviteToken(t, 'robin@example.com');
    const victim = await approvedMember(t, admin, 'victim@example.com');
    await post(t.app, '/v1/auth/signup', { email: 'victim@example.com', password: 'not the password', invite: token, shareWithInviter: true });
    expect(await friendsOf(t, victim.token)).toEqual([]);
    expect((await post(t.app, '/v1/auth/invite-info', { token })).status).toBe(200); // still unclaimed
  });

  it('expires after 30 days, is not mailed twice while open, and stores neither the token nor the address', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    const { t, alex } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'robin@example.com' }, bearer(alex.token));
    await post(t.app, '/v1/friends/invite', { email: 'ROBIN@example.com' }, bearer(alex.token));
    expect(t.mailer.sent.filter((m) => m.to.toLowerCase() === 'robin@example.com')).toHaveLength(1);
    const token = inviteToken(t, 'robin@example.com');
    const rows = JSON.stringify(t.db!.prepare('SELECT * FROM email_invite').all());
    expect(rows).not.toContain('robin');
    expect(rows).not.toContain(token);
    vi.setSystemTime(new Date(Date.now() + (INVITE_TTL_DAYS + 1) * 86_400_000));
    expect((await post(t.app, '/v1/auth/invite-info', { token })).status).toBe(404);
  });

  it('invite-info refuses bad bodies and unknown tokens alike', async () => {
    const { t } = await setup();
    expect((await post(t.app, '/v1/auth/invite-info', {})).status).toBe(400);
    expect((await post(t.app, '/v1/auth/invite-info', { token: 'short' })).status).toBe(400);
    const unknown = await post(t.app, '/v1/auth/invite-info', { token: 'x'.repeat(32) });
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: 'not_found' }]);
  });

  it('deleting the inviter removes their open invites', async () => {
    const { t, alex } = await setup();
    await post(t.app, '/v1/friends/invite', { email: 'robin@example.com' }, bearer(alex.token));
    const token = inviteToken(t, 'robin@example.com');
    expect((await post(t.app, '/v1/me/delete', { password: PASSWORD, confirm: 'DELETE' }, bearer(alex.token))).status).toBe(200);
    expect(t.db!.prepare('SELECT count(*) AS n FROM email_invite').get()).toEqual({ n: 0 });
    expect((await post(t.app, '/v1/auth/invite-info', { token })).status).toBe(404);
  });
});
