import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, describeApiError, parseStoredSession, SESSION_KEY } from '../src/api/client';
import { MemoryStorage } from './helpers/memory-storage';

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
    // region and the rounded point travel only when given; nothing else from the options is copied
    await expect(api.ask('Turdus merula', 'near me?', { region: 'US-IA', near: { lat: 41.7, lon: -91.5 } })).rejects.toBeInstanceOf(ApiError);
    expect(seen[3].body).toEqual({ species: 'Turdus merula', question: 'near me?', region: 'US-IA', near: { lat: 41.7, lon: -91.5 } });
    await expect(api.ask('Turdus merula', 'why?', { region: 'none' })).rejects.toBeInstanceOf(ApiError);
    expect(seen[4].body).toEqual({ species: 'Turdus merula', question: 'why?', region: 'none' });
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

describe('ApiClient: account and friends', () => {
  it('calls the friends and sharing endpoints with the bearer token and updates the cached name', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 'tok', expiresAt: null, user: { ...user, status: 'approved' } }));
    const seen: Array<{ url: string; method: string | undefined; auth: string | undefined; body: unknown }> = [];
    const api = new ApiClient(
      'https://api.test',
      storage,
      fakeFetch((url, init) => {
        const headers = init?.headers as Record<string, string>;
        seen.push({ url: url.replace('https://api.test', ''), method: init?.method, auth: headers.Authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/v1/me/name')) return { status: 200, body: { ok: true, user: { ...user, status: 'approved', name: 'Alex' } } };
        if (url.endsWith('/v1/friends/species')) return { status: 200, body: { friends: [] } };
        if (url.endsWith('/v1/friends')) return { status: 200, body: { friends: [], invites: [] } };
        return { status: 200, body: { ok: true, message: 'Invite sent', count: 0 } };
      }),
    );
    await api.setName('Alex');
    expect(api.user?.name).toBe('Alex');
    expect(JSON.parse(storage.getItem(SESSION_KEY)!).user.name).toBe('Alex');
    await api.inviteFriend('sam@example.com');
    await api.listFriends();
    await api.respondToInvite('inv 1', 'accept');
    await api.removeFriend('f/1');
    await api.friendsSpecies();
    await api.uploadSharedSpecies([{ sci: 'Turdus merula', lastSeen: '2026-10-12' }]);
    await api.clearSharedSpecies();
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /v1/me/name',
      'POST /v1/friends/invite',
      'GET /v1/friends',
      'POST /v1/friends/invites/inv%201/accept',
      'POST /v1/friends/f%2F1/remove',
      'GET /v1/friends/species',
      'POST /v1/me/species',
      'POST /v1/me/species/clear',
    ]);
    expect(seen.every((s) => s.auth === 'Bearer tok')).toBe(true);
    expect(seen[6].body).toEqual({ species: [{ sci: 'Turdus merula', lastSeen: '2026-10-12' }] });
    expect(seen[1].body).toEqual({ email: 'sam@example.com' });
  });

  it('deleteAccount sends the password and the word, keeps the session on a refusal and drops it on success', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 'tok', expiresAt: null, user }));
    const bodies: unknown[] = [];
    let status = 400;
    const api = new ApiClient('https://api.test', storage, fakeFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return status === 200 ? { status, body: { ok: true } } : { status, body: { error: 'wrong_password' } };
    }));
    await expect(api.deleteAccount('secret', 'DELETE')).rejects.toBeInstanceOf(ApiError);
    expect(api.signedIn).toBe(true);
    expect(bodies).toEqual([{ password: 'secret', confirm: 'DELETE' }]);
    status = 200;
    await api.deleteAccount('secret', 'DELETE');
    expect(api.signedIn).toBe(false);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(describeApiError(new ApiError(400, 'admin_account'))).toMatch(/approves other members/);
    expect(describeApiError(new ApiError(400, 'wrong_password'))).toMatch(/password/);
    expect(describeApiError(new ApiError(400, 'confirm_mismatch'))).toMatch(/DELETE/);
    expect(describeApiError(new ApiError(404, 'not_found'))).toMatch(/invite/);
    expect(describeApiError(new ApiError(400, 'unknown_species'))).toMatch(/species/);
  });
});
