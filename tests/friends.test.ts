import { describe, expect, it, vi } from 'vitest';
import { ApiClient, SESSION_KEY, type AuthUser, type FriendSpecies } from '../src/api/client';
import { describeRefreshFailure, describeSpottedBy, fmtDay, FriendsCache, friendsKey, indexFriendsSpecies, REFRESH_BACKOFF_MS } from '../src/species/friends';
import { MemoryStorage } from './helpers/memory-storage';

const member = { id: 'u1', email: 'a@b.co', name: 'Alex', status: 'approved' as const, role: 'member' as const };
const DATA: FriendSpecies[] = [
  { id: 'f1', displayName: 'Sam', species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }, { sci: 'Parus major', lastSeen: '2026-09-30' }, { sci: 'Turdus merula', lastSeen: '2026-01-01' }] },
  { id: 'f2', displayName: 'Riley', species: [{ sci: 'Turdus merula', lastSeen: '2026-10-15' }] },
  { id: 'f3', displayName: 'Quinn', species: [] },
];

function fetchWith(body: unknown, status = 200, calls: string[] = []): typeof fetch {
  return async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}

describe('friends index', () => {
  it('groups by species, newest first, one row per person', () => {
    const idx = indexFriendsSpecies(DATA);
    expect(idx.get('Turdus merula')).toEqual([
      { name: 'Riley', lastSeen: '2026-10-15' },
      { name: 'Sam', lastSeen: '2026-10-12' },
    ]);
    expect(idx.get('Parus major')).toEqual([{ name: 'Sam', lastSeen: '2026-09-30' }]);
    expect(idx.has('Dog')).toBe(false);
    expect(describeSpottedBy(idx.get('Turdus merula')!)).toBe('Spotted by Riley, Sam');
    expect(describeSpottedBy([])).toBe('');
    expect(describeSpottedBy([{ name: 'A', lastSeen: '2026-01-01' }, { name: 'B', lastSeen: '2026-01-01' }, { name: 'C', lastSeen: '2026-01-01' }, { name: 'D', lastSeen: '2026-01-01' }, { name: 'E', lastSeen: '2026-01-01' }])).toBe('Spotted by A, B, C and 2 more');
  });

  it('formats a day without a time-zone shift', () => {
    expect(fmtDay('2026-10-12')).toBe(new Date(2026, 9, 12).toLocaleDateString(undefined, { dateStyle: 'medium' }));
    expect(fmtDay('bogus')).toBe('bogus');
  });
});

describe('FriendsCache', () => {
  const session = (user: AuthUser | null) => {
    const local = new MemoryStorage();
    if (user) local.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: null, user }));
    return local;
  };

  it('is empty when signed out or pending, and never calls the server then', async () => {
    const calls: string[] = [];
    for (const user of [null, { ...member, status: 'pending' as const }]) {
      const api = new ApiClient('https://api.test', session(user), fetchWith({ friends: DATA }, 200, calls));
      const cache = new FriendsCache(api, new MemoryStorage(), () => true);
      await cache.refresh();
      expect(cache.available).toBe(false);
      expect(cache.spottedBy('Turdus merula')).toEqual([]);
      expect(cache.species().size).toBe(0);
      cache.dispose();
    }
    expect(calls).toEqual([]);
  });

  it('fetches for a member when online, caches per user in sessionStorage, keeps the copy offline and drops it on sign-out', async () => {
    const calls: string[] = [];
    const store = new MemoryStorage();
    const local = session(member);
    const api = new ApiClient('https://api.test', local, fetchWith({ friends: DATA }, 200, calls));
    let online = true;
    const cache = new FriendsCache(api, store, () => online);
    expect(cache.spottedBy('Turdus merula')).toEqual([]);
    await cache.refresh();
    expect(calls).toEqual(['https://api.test/v1/friends/species']);
    expect(cache.spottedBy('Turdus merula').map((r) => r.name)).toEqual(['Riley', 'Sam']);
    expect(cache.species()).toEqual(new Set(['Turdus merula', 'Parus major']));
    expect(cache.friendCount).toBe(3);
    expect(JSON.parse(store.getItem(friendsKey('u1'))!)).toEqual(DATA);
    // a new cache for the same user starts from the stored copy; offline it keeps it
    online = false;
    const again = new FriendsCache(new ApiClient('https://api.test', local, fetchWith({ friends: [] }, 200, calls)), store, () => online);
    await again.refresh();
    expect(again.spottedBy('Parus major')).toEqual([{ name: 'Sam', lastSeen: '2026-09-30' }]);
    expect(calls).toHaveLength(1);
    // sign-out: hidden at once and the stored copy is gone
    await api.logout();
    expect(cache.available).toBe(false);
    expect(cache.spottedBy('Turdus merula')).toEqual([]);
    expect(store.getItem(friendsKey('u1'))).toBeNull();
    cache.dispose();
    again.dispose();
  });

  it('says so and retries when the refresh is refused, instead of showing a stale list in silence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const calls: string[] = [];
      let status = 429;
      const fetchImpl: typeof fetch = async (input) => {
        calls.push(String(input));
        return status === 429
          ? new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'content-type': 'application/json' } })
          : new Response(JSON.stringify({ friends: DATA }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const api = new ApiClient('https://api.test', session(member), fetchImpl);
      const cache = new FriendsCache(api, new MemoryStorage(), () => true);
      // The cache refreshes itself, so a copy written before a new friendship is not kept until
      // the Species tab happens to be opened.
      await vi.waitFor(() => expect(cache.lastError).toMatch(/may be out of date/));
      expect(calls).toHaveLength(1);
      // First retry after the first backoff step; it succeeds and clears the message.
      status = 200;
      await vi.advanceTimersByTimeAsync(REFRESH_BACKOFF_MS[0] + 1);
      await vi.waitFor(() => expect(cache.lastError).toBeNull());
      expect(calls).toHaveLength(2);
      expect(cache.spottedBy('Turdus merula').map((r) => r.name)).toEqual(['Riley', 'Sam']);
      cache.dispose();
      // Nothing is left ticking after dispose.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('words a rate-limited refresh differently from any other failure', () => {
    expect(describeRefreshFailure('rate_limited (429)')).toBe('Friends’ birds may be out of date. Retrying…');
    expect(describeRefreshFailure('Rate limit')).toBe('Friends’ birds may be out of date. Retrying…');
    expect(describeRefreshFailure('Failed to fetch')).toBe('Couldn’t refresh friends’ birds: Failed to fetch');
  });

  it('ignores a malformed stored copy and a failing server', async () => {
    const store = new MemoryStorage();
    store.setItem(friendsKey('u1'), JSON.stringify([{ id: 'x', displayName: 'Evil', species: [{ sci: 1, lastSeen: null }] }, 'junk']));
    const api = new ApiClient('https://api.test', session(member), fetchWith({ error: 'internal_error' }, 500));
    const cache = new FriendsCache(api, store, () => true);
    expect(cache.species().size).toBe(0);
    await cache.refresh();
    expect(cache.species().size).toBe(0);
    expect(api.signedIn).toBe(true); // a 500 does not drop the session
    cache.dispose();
  });
});
