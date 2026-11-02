import { describe, expect, it, vi } from 'vitest';
import type { UserStatus } from '../src/api/client';
import { audienceOf, EMPTY_STATE, hasDot, isRunning, listed, mergeStates, parseState, pickAnnouncement, WHATS_NEW, WHATS_NEW_KEY, WhatsNewService, type WhatsNewEntry } from '../src/app/whats-new';
import { MemoryStorage } from './helpers/memory-storage';

const nov = (d: number, h = 12) => new Date(2026, 10, d, h);
const user = (status: UserStatus) => ({ id: 'u1', email: 'a@b.co', name: 'a', role: 'member' as const, status });
const birdamp = WHATS_NEW.find((e) => e.id === '2026-11-birdamp')!;

describe("What's new rules (DECISIONS.md #112)", () => {
  it('runs BirdAmp for the month of November only, by the phone’s calendar', () => {
    expect(isRunning(birdamp, new Date(2026, 9, 31, 23, 59))).toBe(false);
    expect(isRunning(birdamp, nov(1, 0))).toBe(true);
    expect(isRunning(birdamp, nov(30, 23))).toBe(true);
    expect(isRunning(birdamp, new Date(2026, 11, 1, 0, 0))).toBe(false);
  });

  it('picks the announcement once: not when seen, not when muted, not for someone already on BirdAmp', () => {
    const base = { now: nov(2), audience: 'signed-out' as const, state: EMPTY_STATE, layout: 'focus' as const };
    expect(pickAnnouncement(base)?.id).toBe('2026-11-birdamp');
    expect(pickAnnouncement({ ...base, state: { ...EMPTY_STATE, seen: ['2026-11-birdamp'] } })).toBeNull();
    expect(pickAnnouncement({ ...base, state: { ...EMPTY_STATE, muted: true } })).toBeNull();
    expect(pickAnnouncement({ ...base, audience: 'member', layout: 'birdamp' })).toBeNull();
    expect(pickAnnouncement({ ...base, audience: 'member' })?.id).toBe('2026-11-birdamp');
    expect(pickAnnouncement({ ...base, audience: null })).toBeNull();
    expect(pickAnnouncement({ ...base, now: new Date(2026, 11, 1) })).toBeNull();
  });

  it('shows only the newest unseen announcement when several run', () => {
    const a: WhatsNewEntry = { id: 'b-newer', from: '2026-11-10', kind: 'new', title: 'B', text: '', strip: { member: 'B' }, cards: { member: [{ title: 'B', text: '', art: 'map' }] } };
    const b: WhatsNewEntry = { id: 'a-older', from: '2026-11-01', kind: 'new', title: 'A', text: '', strip: { member: 'A' }, cards: { member: [{ title: 'A', text: '', art: 'map' }] } };
    const pick = (seen: string[]) => pickAnnouncement({ entries: [a, b], now: nov(12), audience: 'member', state: { ...EMPTY_STATE, seen }, layout: 'focus' })?.id ?? null;
    expect(pick([])).toBe('b-newer');
    expect(pick(['b-newer'])).toBe('a-older');
  });

  it('words it per audience: sign-up pitch, on its way, or here', () => {
    expect(birdamp.cards?.['signed-out']?.map((c) => c.title)).toEqual(['Meet BirdAmp', 'Ask about any bird you hear', 'Your birds, on a map']);
    expect(birdamp.cards?.pending?.[0].title).toBe('BirdAmp is on its way');
    expect(birdamp.cards?.member?.[0].title).toBe('BirdAmp is here');
    expect(audienceOf(null)).toBe('signed-out');
    expect(audienceOf(user('pending'))).toBe('pending');
    expect(audienceOf(user('approved'))).toBe('member');
    expect(audienceOf(user('disabled'))).toBeNull();
  });

  it('lists what has started, and keeps a dot on Settings until the page is opened', () => {
    expect(listed(new Date(2026, 9, 30)).length).toBe(0);
    expect(listed(nov(2))[0].id).toBe('2026-11-birdamp');
    expect(hasDot(EMPTY_STATE, nov(2))).toBe(true);
    expect(hasDot({ ...EMPTY_STATE, opened: '2026-11-birdamp' }, nov(2))).toBe(false);
  });

  it('combines the phone’s and the account’s copies: every seen id, off if either is off', () => {
    expect(mergeStates({ seen: ['a'], muted: false, opened: 'x' }, { seen: ['b', 'a'], muted: true })).toEqual({ seen: ['a', 'b'], muted: true, opened: 'x' });
    expect(parseState('nonsense')).toEqual(EMPTY_STATE);
    expect(parseState(JSON.stringify({ seen: ['a', 3], muted: 'yes', opened: 1 }))).toEqual({ seen: ['a'], muted: false, opened: null });
  });
});

describe('WhatsNewService', () => {
  const api = (u: ReturnType<typeof user> | null, remote = { seen: [] as string[], muted: false }) => ({
    user: u,
    getWhatsNew: vi.fn(async () => remote),
    postWhatsNew: vi.fn(async (p: { seen?: string[]; muted?: boolean }) => ({ seen: p.seen ?? [], muted: p.muted ?? false })),
  });

  it('marks seen on the phone at once, tells the account when signed in, and shows one strip per visit', async () => {
    const storage = new MemoryStorage();
    const a = api(user('approved'));
    const s = new WhatsNewService(a, storage);
    expect(s.pick('member', 'focus', nov(2))?.id).toBe('2026-11-birdamp');
    s.markSeen('2026-11-birdamp');
    expect(JSON.parse(storage.getItem(WHATS_NEW_KEY)!).seen).toEqual(['2026-11-birdamp']);
    expect(a.postWhatsNew).toHaveBeenCalledWith({ seen: ['2026-11-birdamp'] });
    expect(new WhatsNewService(a, storage).pick('member', 'focus', nov(2))).toBeNull();
  });

  it('brings in what another phone saw before deciding, and never stalls Listen when the server is slow or gone', async () => {
    const storage = new MemoryStorage();
    const s = new WhatsNewService(api(user('approved'), { seen: ['2026-11-birdamp'], muted: false }), storage);
    await s.ready();
    expect(s.pick('member', 'focus', nov(2))).toBeNull();
    const failing = new WhatsNewService({ user: user('approved'), getWhatsNew: async () => Promise.reject(new Error('offline')), postWhatsNew: async () => ({ seen: [], muted: false }) }, new MemoryStorage());
    await failing.ready();
    expect(failing.pick('member', 'focus', nov(2))?.id).toBe('2026-11-birdamp');
    const slow = new WhatsNewService({ user: user('approved'), getWhatsNew: () => new Promise(() => undefined), postWhatsNew: async () => ({ seen: [], muted: false }) }, new MemoryStorage());
    const t0 = Date.now();
    await slow.ready(30);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('"Don’t show me this again" turns off later pop-ups too, and the switch turns them back on', () => {
    const storage = new MemoryStorage();
    const a = api(null);
    const s = new WhatsNewService(a, storage);
    s.setMuted(true);
    expect(s.pick('signed-out', 'focus', nov(2))).toBeNull();
    expect(a.postWhatsNew).not.toHaveBeenCalled(); // signed out: phone only
    s.setMuted(false);
    expect(s.pick('signed-out', 'focus', nov(2))?.id).toBe('2026-11-birdamp');
  });
});
