import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, SESSION_KEY, type AuthUser } from '../src/api/client';
import { Emitter } from '../src/shared/emitter';
import { buildSharedSpeciesList, isSharingOn, localDay, setSharingOn, SHARING_CONSENT_TEXT, SpeciesSharer, UPLOAD_DEBOUNCE_MS } from '../src/species/sharing';
import { clearAllData, recordDetections } from '../src/storage/db';
import type { DetectionRecord } from '../src/storage/types';
import { MemoryStorage } from './helpers/memory-storage';

const member = { id: 'u1', email: 'a@b.co', name: 'Alex', status: 'approved' as const, role: 'member' as const };

function det(scientific: string, time: number, extra: Partial<DetectionRecord> = {}): DetectionRecord {
  return { id: `${scientific}-${time}`, time, label: `${scientific}_X`, scientific, common: 'X', confidence: 0.9, lat: 51.5, lon: -0.1, accuracy: 10, recordingId: null, offsetSec: null, source: 'live', sessionId: 's1', ...extra };
}

function fakeFetch(calls: Array<{ url: string; body: unknown }>, status = 200): typeof fetch {
  return async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, count: 0 }), { status, headers: { 'content-type': 'application/json' } });
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
    expect(SHARING_CONSENT_TEXT).toContain('which birds you’ve spotted and the date you last spotted each one');
  });
});

/** Fire the faked debounce timers, then let the real IndexedDB work (setImmediate) and the fetch settle. */
async function settle(): Promise<void> {
  await vi.runAllTimersAsync();
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

describe('SpeciesSharer', () => {
  beforeEach(async () => {
    await clearAllData();
    // Only the debounce timer is faked; fake-indexeddb schedules its work with setImmediate and must keep running.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => vi.useRealTimers());

  const build = (user: AuthUser | null, sharing: boolean, online = true) => {
    const storage = new MemoryStorage();
    if (user) storage.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: null, user }));
    const calls: Array<{ url: string; body: unknown }> = [];
    const api = new ApiClient('https://api.test', storage, fakeFetch(calls));
    if (user && sharing) setSharingOn(user.id, true, storage);
    const controller = new Emitter<{ 'detections-changed': undefined }>();
    const sharer = new SpeciesSharer(api, controller, storage, () => online);
    return { api, calls, controller, sharer, storage };
  };

  it('uploads the full current list once, debounced, after detections change', async () => {
    const { calls, controller, sharer } = build(member, true);
    await settle(); // the start-up sync with no sightings
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/v1/me/species']);
    expect(calls[0].body).toEqual({ species: [] });
    calls.length = 0;
    const day = new Date(2026, 9, 12, 8).getTime();
    await recordDetections([det('Turdus merula', day), det('Turdus merula', day + 10_000), det('Parus major', day - 86_400_000)]);
    controller.emit('detections-changed', undefined);
    controller.emit('detections-changed', undefined);
    controller.emit('detections-changed', undefined);
    await vi.advanceTimersByTimeAsync(UPLOAD_DEBOUNCE_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Parus major', lastSeen: '2026-10-11' }] });
    sharer.dispose();
  });

  it('sends nothing while sharing is off, signed out, not approved or offline', async () => {
    for (const [user, sharing, online] of [
      [member, false, true],
      [null, true, true],
      [{ ...member, status: 'pending' as const }, true, true],
      [member, true, false],
    ] as const) {
      const { calls, controller, sharer } = build(user, sharing, online);
      controller.emit('detections-changed', undefined);
      await settle();
      expect(calls, JSON.stringify([user?.status, sharing, online])).toHaveLength(0);
      sharer.dispose();
    }
  });

  it('turning sharing on uploads at once; turning it off clears the server copy and stops uploads', async () => {
    const { calls, controller, sharer, storage } = build(member, false);
    await settle();
    expect(calls).toHaveLength(0);
    await sharer.setEnabled(true);
    expect(sharer.enabled).toBe(true);
    expect(isSharingOn('u1', storage)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/v1/me/species']);
    await sharer.setEnabled(false);
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/v1/me/species', 'https://api.test/v1/me/species/clear']);
    expect(isSharingOn('u1', storage)).toBe(false);
    controller.emit('detections-changed', undefined);
    await settle();
    expect(calls).toHaveLength(2);
    sharer.dispose();
  });

  it('the consent does not follow the session to another account', async () => {
    const { api, calls, sharer, storage } = build(member, true);
    await settle();
    expect(calls).toHaveLength(1);
    await api.logout();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 't2', expiresAt: null, user: { ...member, id: 'u2' } }));
    const other = new ApiClient('https://api.test', storage, fakeFetch(calls));
    const sharer2 = new SpeciesSharer(other, new Emitter<{ 'detections-changed': undefined }>(), storage, () => true);
    await settle();
    expect(sharer2.enabled).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('/v1/me/species'))).toHaveLength(1);
    sharer.dispose();
    sharer2.dispose();
  });
});
