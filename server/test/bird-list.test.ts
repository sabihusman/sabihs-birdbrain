import { describe, expect, it } from 'vitest';
import { MAX_DEVICES } from '../src/bird-list.js';
import { openDatabase } from '../src/db.js';
import { ADMIN, approvedMember, bearer, buildTestApp, get, post, signUpAndLogin, type TestApp } from './helpers.js';

/** The account's bird list across devices (DECISIONS.md #139). */

interface View {
  sharing: boolean | null;
  species: Array<{ sci: string; lastSeen: string }>;
  devices: Array<{ id: string; label: string; count: number; syncedAt: number | null }>;
}

const PHONE = 'aaaaaaaa-1111-4111-8111-111111111111';
const LAPTOP = 'bbbbbbbb-2222-4222-8222-222222222222';
const blackbird = (lastSeen: string) => ({ sci: 'Turdus merula', lastSeen });
const tit = (lastSeen: string) => ({ sci: 'Parus major', lastSeen });

async function setup() {
  const t = await buildTestApp({ limits: { ipPerWindow: 10_000, emailPerWindow: 10_000 } });
  const admin = await signUpAndLogin(t, ADMIN);
  const alex = await approvedMember(t, admin, 'alex@example.com');
  const sam = await approvedMember(t, admin, 'sam@example.com');
  await post(t.app, '/v1/me/name', { name: 'Alex' }, bearer(alex.token));
  await post(t.app, '/v1/me/name', { name: 'Sam' }, bearer(sam.token));
  return { t, admin, alex, sam };
}

const sync = (t: TestApp, token: string, deviceId: string, species: Array<{ sci: string; lastSeen: string }>, label = 'iPhone · Safari') => post(t.app, '/v1/me/birds/sync', { deviceId, label, species }, bearer(token));
const view = async (t: TestApp, token: string) => (await (await get(t.app, '/v1/me/birds', bearer(token))).json()) as View;

async function befriend(t: TestApp, alex: { token: string }, sam: { token: string }) {
  await post(t.app, '/v1/friends/invite', { email: 'sam@example.com' }, bearer(alex.token));
  const inv = ((await (await get(t.app, '/v1/friends', bearer(sam.token))).json()) as { invites: Array<{ id: string }> }).invites[0];
  await post(t.app, `/v1/friends/invites/${inv.id}/accept`, {}, bearer(sam.token));
}

describe('one list across devices', () => {
  it('each device replaces its own set; the account list is the union with the latest day', async () => {
    const { t, alex } = await setup();
    expect(await view(t, alex.token)).toEqual({ sharing: null, species: [], devices: [] });
    let r = await sync(t, alex.token, PHONE, [blackbird('2026-11-20'), tit('2026-11-01')]);
    expect(r.status).toBe(200);
    r = await sync(t, alex.token, LAPTOP, [blackbird('2026-11-22')], 'Mac · Chrome');
    const v = (await r.json()) as View;
    expect(v.species).toEqual([blackbird('2026-11-22'), tit('2026-11-01')]);
    expect(v.devices.map((d) => [d.label, d.count])).toEqual(
      expect.arrayContaining([
        ['iPhone · Safari', 2],
        ['Mac · Chrome', 1],
      ]),
    );
    // Removed on the phone: the laptop still has the blackbird, so it stays; the tit goes.
    await sync(t, alex.token, PHONE, []);
    expect((await view(t, alex.token)).species).toEqual([blackbird('2026-11-22')]);
    // Forget the laptop: nothing left.
    const f = await post(t.app, `/v1/me/birds/devices/${LAPTOP}/forget`, {}, bearer(alex.token));
    expect(f.status).toBe(200);
    expect(((await f.json()) as View).species).toEqual([]);
    expect((await post(t.app, `/v1/me/birds/devices/${LAPTOP}/forget`, {}, bearer(alex.token))).status).toBe(404);
  });

  it('accounts never see each other’s lists, and only members have one', async () => {
    const { t, admin, alex, sam } = await setup();
    await sync(t, alex.token, PHONE, [blackbird('2026-11-20')]);
    expect((await view(t, sam.token)).species).toEqual([]);
    // Sam cannot forget Alex's device.
    expect((await post(t.app, `/v1/me/birds/devices/${PHONE}/forget`, {}, bearer(sam.token))).status).toBe(404);
    expect((await view(t, alex.token)).species).toHaveLength(1);
    expect((await get(t.app, '/v1/me/birds')).status).toBe(401);
    const pending = await signUpAndLogin(t, 'wait@example.com');
    expect((await sync(t, pending, PHONE, [])).status).toBe(403);
    void admin;
  });

  it('refuses bad lists and ids, and more than the device limit', async () => {
    const { t, alex } = await setup();
    expect((await sync(t, alex.token, PHONE, [{ sci: 'Nope nope', lastSeen: '2026-11-20' }])).status).toBe(400);
    expect((await sync(t, alex.token, PHONE, [blackbird('2026-11-20'), blackbird('2026-11-21')])).status).toBe(400);
    expect((await sync(t, alex.token, PHONE, [blackbird('2026-02-30')])).status).toBe(400);
    for (const id of ['short', 'earlier-uploads', '../../etc', 'x'.repeat(65)]) expect((await sync(t, alex.token, id, [])).status, id).toBe(400);
    expect((await sync(t, alex.token, PHONE, [], 'bad‮name')).status).toBe(400);
    for (let i = 0; i < MAX_DEVICES; i++) expect((await sync(t, alex.token, `device-${String(i).padStart(4, '0')}`, [])).status).toBe(200);
    expect((await sync(t, alex.token, PHONE, [])).status).toBe(409);
    // A device already known keeps syncing.
    expect((await sync(t, alex.token, 'device-0000', [blackbird('2026-11-20')])).status).toBe(200);
  });
});

describe('sharing with friends', () => {
  it('friends see the account list only while sharing is on; turning it off keeps the list', async () => {
    const { t, alex, sam } = await setup();
    await befriend(t, alex, sam);
    await sync(t, sam.token, PHONE, [blackbird('2026-11-20')]);
    await sync(t, sam.token, LAPTOP, [tit('2026-11-21')]);
    const friendsOf = async () => ((await (await get(t.app, '/v1/friends/species', bearer(alex.token))).json()) as { friends: Array<{ species: unknown[] }> }).friends[0].species;
    expect(await friendsOf()).toEqual([]); // never chose: not shared
    expect(((await (await post(t.app, '/v1/me/sharing', { on: true }, bearer(sam.token))).json()) as View).sharing).toBe(true);
    expect(await friendsOf()).toEqual([tit('2026-11-21'), blackbird('2026-11-20')]);
    await post(t.app, '/v1/me/sharing', { on: false }, bearer(sam.token));
    expect(await friendsOf()).toEqual([]);
    expect((await view(t, sam.token)).species).toHaveLength(2);
  });

  it('an older app still works: its upload is "Earlier uploads" and turns sharing on; its clear turns it off', async () => {
    const { t, alex, sam } = await setup();
    await befriend(t, alex, sam);
    await post(t.app, '/v1/me/species', { species: [blackbird('2026-11-01')] }, bearer(sam.token));
    await sync(t, sam.token, PHONE, [tit('2026-11-21')]);
    const v = await view(t, sam.token);
    expect(v.sharing).toBe(true);
    expect(v.species).toEqual([tit('2026-11-21'), blackbird('2026-11-01')]);
    expect(v.devices.find((d) => d.id === 'earlier-uploads')).toMatchObject({ label: 'Earlier uploads', count: 1, syncedAt: null });
    // Forgetting "Earlier uploads" removes those rows only.
    await post(t.app, '/v1/me/birds/devices/earlier-uploads/forget', {}, bearer(sam.token));
    expect((await view(t, sam.token)).species).toEqual([tit('2026-11-21')]);
    await post(t.app, '/v1/me/species', { species: [blackbird('2026-11-01')] }, bearer(sam.token));
    await post(t.app, '/v1/me/species/clear', {}, bearer(sam.token));
    expect(await view(t, sam.token)).toMatchObject({ sharing: false, species: [tit('2026-11-21')] });
  });

  it('a database from before keeps sharing on for accounts that had a list, once', () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO shared_species (user_id, scientific, last_seen) VALUES ('u1', 'Turdus merula', '2026-11-01')").run();
    db.prepare("INSERT INTO species_sharing (user_id, sharing) VALUES ('u2', 0)").run();
    db.prepare("INSERT INTO shared_species (user_id, scientific, last_seen) VALUES ('u2', 'Turdus merula', '2026-11-01')").run();
    // The same statement runs at every start: it fills only accounts that never chose.
    db.exec('INSERT OR IGNORE INTO species_sharing (user_id, sharing) SELECT DISTINCT user_id, 1 FROM shared_species');
    const rows = db.prepare('SELECT user_id, sharing FROM species_sharing ORDER BY user_id').all() as Array<{ user_id: string; sharing: number }>;
    expect(rows.map((r) => [r.user_id, Number(r.sharing)])).toEqual([
      ['u1', 1],
      ['u2', 0],
    ]);
  });
});

describe('deleting the account', () => {
  it('takes its devices, birds and sharing choice', async () => {
    const { t, alex } = await setup();
    await sync(t, alex.token, PHONE, [blackbird('2026-11-20')]);
    await post(t.app, '/v1/me/sharing', { on: true }, bearer(alex.token));
    expect((await post(t.app, '/v1/me/delete', { password: 'correct horse battery staple', confirm: 'DELETE' }, bearer(alex.token))).status).toBe(200);
    for (const table of ['bird_device', 'device_bird', 'species_sharing']) expect(Number((t.db!.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n), table).toBe(0);
  });
});
