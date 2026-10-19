import { describe, expect, it } from 'vitest';
import { ApiClient, SESSION_KEY } from '../src/api/client';
import { isMember, lockedNote, memberAccess } from '../src/app/access';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return Array.from(this.m.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const base = { id: 'u1', email: 'a@b.co', name: 'a', role: 'member' as const };
const offlineFetch: typeof fetch = async () => {
  throw new TypeError('Failed to fetch');
};

describe('member gating', () => {
  it('classifies the cached user', () => {
    expect(memberAccess(null)).toBe('signed-out');
    expect(memberAccess({ ...base, status: 'pending' })).toBe('pending');
    expect(memberAccess({ ...base, status: 'approved' })).toBe('member');
    expect(memberAccess({ ...base, status: 'rejected' })).toBe('blocked');
    expect(memberAccess({ ...base, status: 'disabled' })).toBe('blocked');
    expect(isMember({ ...base, status: 'approved', role: 'admin' })).toBe(true);
    expect(isMember({ ...base, status: 'pending' })).toBe(false);
  });

  it('wording for the locked note', () => {
    expect(lockedNote('signed-out', 'the species ID card')).toBe('Sign in to unlock the species ID card.');
    expect(lockedNote('pending', 'Sighting history')).toMatch(/approved/);
    expect(lockedNote('blocked', 'species clips')).toMatch(/cannot/);
  });

  it('works offline from the cached approved session, without asking the server', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: null, user: { ...base, status: 'approved' } }));
    const api = new ApiClient('https://api.invalid', storage, offlineFetch);
    expect(isMember(api.user)).toBe(true);
    // A failed refresh (offline) keeps the cached user.
    expect(await api.refresh()).toMatchObject({ status: 'approved' });
    expect(isMember(api.user)).toBe(true);
  });

  it('an expired cached session or a pending user does not unlock', () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: '2000-01-01T00:00:00Z', user: { ...base, status: 'approved' } }));
    expect(isMember(new ApiClient('https://api.invalid', storage, offlineFetch).user)).toBe(false);
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: null, user: { ...base, status: 'pending' } }));
    expect(isMember(new ApiClient('https://api.invalid', storage, offlineFetch).user)).toBe(false);
  });

  it('sign-out hides the features even when the server is unreachable', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 't', expiresAt: null, user: { ...base, status: 'approved' } }));
    const api = new ApiClient('https://api.invalid', storage, offlineFetch);
    const seen: Array<boolean> = [];
    api.on('change', (u) => seen.push(isMember(u)));
    await api.logout().catch(() => undefined);
    expect(api.user).toBeNull();
    expect(seen).toEqual([false]);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
  });
});
