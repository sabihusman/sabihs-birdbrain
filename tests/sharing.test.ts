import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, SESSION_KEY, type AuthUser } from '../src/api/client';
import { Emitter } from '../src/shared/emitter';
import { buildSharedSpeciesList, isSharingOn, localDay, setSharingOn, SHARING_CONSENT_TEXT, SpeciesSharer, UPLOAD_BACKOFF_MS, UPLOAD_DEBOUNCE_MS } from '../src/species/sharing';
import { deviceLabel } from '../src/species/device';
import { clearAllData, recordDetections, removeSpecies } from '../src/storage/db';
import type { DetectionRecord } from '../src/storage/types';
import { MemoryStorage } from './helpers/memory-storage';

const member = { id: 'u1', email: 'a@b.co', name: 'Alex', status: 'approved' as const, role: 'member' as const };

function det(scientific: string, time: number, extra: Partial<DetectionRecord> = {}): DetectionRecord {
  return { id: `${scientific}-${time}`, time, label: `${scientific}_X`, scientific, common: 'X', confidence: 0.9, lat: 51.5, lon: -0.1, accuracy: 10, recordingId: null, offsetSec: null, source: 'live', sessionId: 's1', ...extra };
}

/** A stand-in server for the account list (DECISIONS.md #139): devices' sets, their union and the sharing choice. */
function fakeServer(calls: Array<{ url: string; body: unknown }>, state = { sharing: null as boolean | null, sets: new Map<string, Array<{ sci: string; lastSeen: string }>>() }): typeof fetch {
  const view = () => {
    const best = new Map<string, string>();
    for (const set of state.sets.values()) for (const b of set) if (!best.has(b.sci) || b.lastSeen > best.get(b.sci)!) best.set(b.sci, b.lastSeen);
    return { sharing: state.sharing, species: [...best].map(([sci, lastSeen]) => ({ sci, lastSeen })), devices: [...state.sets].map(([id, set]) => ({ id, label: 'd', count: set.length, syncedAt: 1 })) };
  };
  return async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/v1/me/birds/sync')) state.sets.set(body.deviceId, body.species);
    if (url.endsWith('/v1/me/sharing')) state.sharing = body.on;
    const forget = /\/v1\/me\/birds\/devices\/([^/]+)\/forget$/.exec(url);
    if (forget) state.sets.delete(decodeURIComponent(forget[1]));
    return new Response(JSON.stringify(view()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('what leaves the device', () => {
  it('localDay is the device calendar day, not UTC', () => {
    const d = new Date(2026, 9, 12, 23, 30); // local 12 Oct 23:30
    expect(localDay(d.getTime())).toBe('2026-10-12');
    expect(localDay(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01');
  });

  it('one entry per species with only the most recent day, newest first, capped', () => {
    const t = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
    const list = buildSharedSpeciesList([
      { scientific: 'Turdus merula', lastTime: t(2026, 10, 1) },
      { scientific: 'Turdus merula', lastTime: t(2026, 10, 12) },
      { scientific: 'Turdus merula', lastTime: t(2026, 9, 3) },
      { scientific: 'Parus major', lastTime: t(2026, 10, 5) },
      { scientific: '', lastTime: t(2026, 10, 5) },
    ]);
    expect(list).toEqual([
      { sci: 'Turdus merula', lastSeen: '2026-10-12' },
      { sci: 'Parus major', lastSeen: '2026-10-05' },
    ]);
    for (const e of list) expect(Object.keys(e).sort()).toEqual(['lastSeen', 'sci']);
    expect(JSON.stringify(list)).not.toMatch(/lat|lon|hits|confidence|T\d\d:/);
    const many = Array.from({ length: 2500 }, (_, i) => ({ scientific: `Sp ${i}`, lastTime: t(2020, 1, 1) + i * 86_400_000 }));
    const capped = buildSharedSpeciesList(many);
    expect(capped).toHaveLength(2000);
    expect(capped[0].sci).toBe('Sp 2499'); // the oldest fall off
    expect(buildSharedSpeciesList([])).toEqual([]);
  });

  it('the consent flag is per user id and off by default', () => {
    const storage = new MemoryStorage();
    expect(isSharingOn('u1', storage)).toBe(false);
    expect(isSharingOn(null, storage)).toBe(false);
    setSharingOn('u1', true, storage);
    expect(isSharingOn('u1', storage)).toBe(true);
    expect(isSharingOn('u2', storage)).toBe(false);
    setSharingOn('u1', false, storage);
    expect(isSharingOn('u1', storage)).toBe(false);
    expect(SHARING_CONSENT_TEXT).toContain('which birds you’ve spotted on any of your devices and the date you last spotted each one');
  });
});

/** Fire the faked debounce timers, then let the real IndexedDB work (setImmediate) and the fetch settle. */
async function settle(): Promise<void> {
  await vi.runAllTimersAsync();
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

describe('the account bird list (DECISIONS.md #139)', () => {
  beforeEach(async () => {
    await clearAllData();
    // Only the debounce timer is faked; fake-indexeddb schedules its work with setImmediate and must keep running.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  const build = (user: AuthUser | null, opts: { online?: boolean; wish?: boolean; server?: Parameters<typeof fakeServer>[1] } = {}) => {
    const storage = new MemoryStorage();
    if (user) storage.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: null, user }));
    if (user && opts.wish) setSharingOn(user.id, true, storage);
    const calls: Array<{ url: string; body: unknown }> = [];
    const api = new ApiClient('https://api.test', storage, fakeServer(calls, opts.server));
    const controller = new Emitter<{ 'detections-changed': undefined }>();
    const sharer = new SpeciesSharer(api, controller, storage, () => opts.online ?? true);
    return { api, calls, controller, sharer, storage };
  };
  const day = new Date(2026, 9, 12, 8).getTime();

  it('sends this device’s whole set, debounced, after detections change; only names and days', async () => {
    const { calls, controller, sharer } = build(member);
    await settle(); // the start-up sync with no sightings
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/v1/me/birds/sync']);
    expect(calls[0].body).toEqual({ deviceId: sharer.deviceId, label: deviceLabel(), species: [] });
    calls.length = 0;
    await recordDetections([det('Turdus merula', day), det('Turdus merula', day + 10_000), det('Parus major', day - 86_400_000)]);
    for (let i = 0; i < 3; i++) controller.emit('detections-changed', undefined);
    await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { species: unknown }).species).toEqual([{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Parus major', lastSeen: '2026-10-11' }]);
    expect([...sharer.accountBirds().keys()]).toEqual(['Turdus merula', 'Parus major']);
    sharer.dispose();
  });

  it('a bird removed here leaves this device’s set; another device’s copy keeps it on the account list', async () => {
    const server = { sharing: null as boolean | null, sets: new Map([['other-device-1', [{ sci: 'Turdus merula', lastSeen: '2026-10-20' }]]]) };
    const { controller, sharer } = build(member, { server });
    await recordDetections([det('Turdus merula', day), det('Parus major', day)]);
    controller.emit('detections-changed', undefined);
    await settle();
    expect(server.sets.get(sharer.deviceId)?.map((b) => b.sci).sort()).toEqual(['Parus major', 'Turdus merula']);
    await removeSpecies('Turdus merula');
    await removeSpecies('Parus major');
    controller.emit('detections-changed', undefined);
    await settle();
    expect(server.sets.get(sharer.deviceId)).toEqual([]);
    expect([...sharer.accountBirds()]).toEqual([['Turdus merula', '2026-10-20']]);
    await sharer.forgetDevice('other-device-1');
    expect(sharer.accountBirds().size).toBe(0);
    sharer.dispose();
  });

  it('sends nothing while signed out, not approved or offline', async () => {
    for (const [user, online] of [
      [null, true],
      [{ ...member, status: 'pending' as const }, true],
      [member, false],
    ] as const) {
      const { calls, controller, sharer } = build(user, { online });
      controller.emit('detections-changed', undefined);
      await settle();
      expect(calls, JSON.stringify([user?.status, online])).toHaveLength(0);
      expect(sharer.accountBirds().size).toBe(0);
      sharer.dispose();
    }
  });

  it('sharing is the account’s choice; off hides the list from friends and keeps it', async () => {
    const { calls, sharer, storage } = build(member);
    await settle();
    expect(sharer.enabled).toBe(false);
    await sharer.setEnabled(true);
    expect(sharer.enabled).toBe(true);
    expect(calls.at(-1)).toEqual({ url: 'https://api.test/v1/me/sharing', body: { on: true } });
    await sharer.setEnabled(false);
    expect(sharer.enabled).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/v1/me/species/clear'))).toBe(false);
    expect(isSharingOn('u1', storage)).toBe(false);
    sharer.dispose();
  });

  it('carries a phone’s old "on" (or a sign-up tick) to an account that never chose, once; never over a choice', async () => {
    const { calls, sharer, storage } = build(member, { wish: true });
    await settle();
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/v1/me/birds/sync', 'https://api.test/v1/me/sharing']);
    expect(sharer.enabled).toBe(true);
    expect(isSharingOn('u1', storage)).toBe(false);
    const chose = build(member, { wish: true, server: { sharing: false, sets: new Map() } });
    await settle();
    expect(chose.calls.map((c) => c.url)).toEqual(['https://api.test/v1/me/birds/sync']);
    expect(chose.sharer.enabled).toBe(false);
    sharer.dispose();
    chose.sharer.dispose();
  });

  it('retries a refused sync and reports it until one succeeds', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: null, user: member }));
    const calls: Array<{ url: string; body: unknown }> = [];
    let status = 429;
    const ok = fakeServer([]);
    const api = new ApiClient('https://api.test', storage, async (input, init) => {
      calls.push({ url: String(input), body: undefined });
      if (status === 429) return new Response(JSON.stringify({ error: 'rate_limited' }), { status, headers: { 'content-type': 'application/json' } });
      return ok(input, init);
    });
    const sharer = new SpeciesSharer(api, new Emitter<{ 'detections-changed': undefined }>(), storage, () => true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(sharer.lastError).toBeTruthy();
    status = 200;
    await vi.advanceTimersByTimeAsync(UPLOAD_BACKOFF_MS[0] + 1);
    await settle();
    expect(calls).toHaveLength(2);
    expect(sharer.lastError).toBeNull();
    sharer.dispose();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('keeps the last list per account offline, and never shows one account’s list to another', async () => {
    const { api, sharer, storage } = build(member, { server: { sharing: true, sets: new Map([['x-device-1', [{ sci: 'Parus major', lastSeen: '2026-10-01' }]]]) } });
    await settle();
    expect(sharer.accountBirds().has('Parus major')).toBe(true);
    // Offline next time: the kept list still gives the ticks.
    const offline = new SpeciesSharer(api, new Emitter<{ 'detections-changed': undefined }>(), storage, () => false);
    expect(offline.accountBirds().has('Parus major')).toBe(true);
    // Another account on the same phone sees nothing of it.
    await api.logout();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 't2', expiresAt: null, user: { ...member, id: 'u2' } }));
    const other = new SpeciesSharer(new ApiClient('https://api.test', storage, fakeServer([])), new Emitter<{ 'detections-changed': undefined }>(), storage, () => false);
    expect(other.accountBirds().size).toBe(0);
    expect(other.enabled).toBe(false);
    sharer.dispose();
    offline.dispose();
    other.dispose();
  });

  it('names the device from its browser, and nothing more', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Chrome');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36')).toBe('Android phone · Chrome');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36 Edg/150.0')).toBe('Windows computer · Edge');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Mac · Firefox');
    expect(deviceLabel('')).toBe('Device');
  });
});
