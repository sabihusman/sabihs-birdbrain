import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, describeApiError, parseStoredSession, SESSION_KEY } from '../src/api/client';

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

const user = { id: 'u1', email: 'a@b.co', name: 'a', status: 'pending' as const, role: 'member' as const };

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return async (input, init) => {
    const r = handler(String(input), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
}

describe('ApiClient', () => {
  it('ignores expired or malformed stored sessions', () => {
    expect(parseStoredSession(null)).toBeNull();
    expect(parseStoredSession('{bad')).toBeNull();
    expect(parseStoredSession(JSON.stringify({ token: 't', expiresAt: '2000-01-01T00:00:00Z', user }))).toBeNull();
    expect(parseStoredSession(JSON.stringify({ token: 't', expiresAt: null, user }))?.token).toBe('t');
  });

  it('runs login -> verify and then sends the bearer token', async () => {
    const storage = new MemoryStorage();
    const seen: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    const api = new ApiClient(
      'https://api.test',
      storage,
      fakeFetch((url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push({ url, auth: headers.Authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/v1/auth/login')) return { status: 200, body: { challenge: 'c1', expiresInSeconds: 600 } };
        if (url.endsWith('/v1/auth/verify')) return { status: 200, body: { token: 'tok', expiresAt: '2999-01-01T00:00:00Z', user } };
        if (url.endsWith('/v1/ask')) return { status: 403, body: { error: 'not_approved' } };
        return { status: 404, body: { error: 'not_found' } };
      }),
    );
    expect(api.signedIn).toBe(false);
    const res = await api.login('a@b.co', 'correct horse battery');
    expect(res.challenge).toBe('c1');
    expect(seen[0].auth).toBeUndefined();
    await api.verify('c1', '123456');
    expect(api.user?.email).toBe('a@b.co');
    expect(JSON.parse(storage.getItem(SESSION_KEY)!).token).toBe('tok');
    await expect(api.ask('Turdus merula', 'why?')).rejects.toBeInstanceOf(ApiError);
    expect(seen[2].auth).toBe('Bearer tok');
    expect(seen[2].body).toEqual({ species: 'Turdus merula', question: 'why?' });
  });

  it('drops the session on 401 and maps error codes to text', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 'old', expiresAt: null, user }));
    const api = new ApiClient('https://api.test', storage, fakeFetch(() => ({ status: 401, body: { error: 'unauthorized' } })));
    expect(api.signedIn).toBe(true);
    await api.refresh();
    expect(api.signedIn).toBe(false);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(describeApiError(new ApiError(429, 'user_cap'))).toMatch(/limit/);
    expect(describeApiError(new ApiError(401, 'invalid_code'))).toMatch(/code/);
  });
});
