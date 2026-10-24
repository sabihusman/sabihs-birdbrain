import { describe, expect, it } from 'vitest';
import { ADMIN, buildTestApp, codeFrom, get, ORIGIN, post, signUpAndLogin } from './helpers.js';

describe('auth flow (integration, fake mailer, in-memory SQLite)', () => {
  it('signs up, requires the emailed code, gates /v1/ask until approved, and lets the admin approve', async () => {
    const t = await buildTestApp();
    const email = 'member@example.com';
    const password = 'correct horse battery staple';

    // signup: a challenge and a code by mail; the answer has the same shape whether or not the address exists
    const su1 = await post(t.app, '/v1/auth/signup', { email, password });
    expect(su1.status).toBe(200);
    const su1Body = (await su1.json()) as { challenge: string; expiresInSeconds: number; token?: string };
    expect(su1Body.token).toBeUndefined();
    expect(t.mailer.last(email)?.subject).toBe('Your Birdbrain code');
    const su2 = await post(t.app, '/v1/auth/signup', { email, password: 'another password here' });
    expect(su2.status).toBe(200);
    const su2Body = (await su2.json()) as { challenge: string; expiresInSeconds: number };
    expect(Object.keys(su2Body).sort()).toEqual(Object.keys(su1Body).sort());
    expect(su2Body.challenge).toHaveLength(su1Body.challenge.length);
    expect(su2Body.expiresInSeconds).toBe(su1Body.expiresInSeconds);
    // the owner is told instead, with no code, and the second challenge matches nothing
    expect(t.mailer.last(email)?.subject).toBe('You already have a Birdbrain account');
    expect(t.mailer.last(email)?.text).not.toMatch(/\b\d{6}\b/);
    expect((await post(t.app, '/v1/auth/verify', { challenge: su2Body.challenge, code: '123456' })).status).toBe(401);
    const sentBefore = t.mailer.sent.length;

    // wrong password: generic 401, no mail
    const bad = await post(t.app, '/v1/auth/login', { email, password: 'wrong password here!' });
    expect(bad.status).toBe(401);
    expect(t.mailer.sent.length).toBe(sentBefore);

    // login sends a code and returns a challenge, not a token
    const li = await post(t.app, '/v1/auth/login', { email, password });
    expect(li.status).toBe(200);
    const liBody = (await li.json()) as { challenge: string; token?: string };
    expect(liBody.token).toBeUndefined();
    expect(t.mailer.sent.length).toBe(sentBefore + 1);
    const code = codeFrom(t.mailer, email);

    // wrong code is rejected; right code releases the token
    const wrong = await post(t.app, '/v1/auth/verify', { challenge: liBody.challenge, code: code === '000000' ? '000001' : '000000' });
    expect(wrong.status).toBe(401);
    const ve = await post(t.app, '/v1/auth/verify', { challenge: liBody.challenge, code });
    expect(ve.status).toBe(200);
    const { token, user } = (await ve.json()) as { token: string; user: { status: string; role: string } };
    expect(user.status).toBe('pending');
    expect(user.role).toBe('member');
    // the challenge is single-use
    expect((await post(t.app, '/v1/auth/verify', { challenge: liBody.challenge, code })).status).toBe(401);

    // bearer session works; no cookie needed
    const me = await get(t.app, '/v1/me', { authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);
    expect((await get(t.app, '/v1/me')).status).toBe(401);
    expect((await get(t.app, '/v1/me', { authorization: 'Bearer nonsense' })).status).toBe(401);

    // pending member cannot ask
    const askPending = await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What does it eat?' }, { authorization: `Bearer ${token}` });
    expect(askPending.status).toBe(403);
    expect(t.modelCalls.length).toBe(0);

    // admin signs up (auto-approved via ADMIN_EMAIL), approves the member
    const adminToken = await signUpAndLogin(t, ADMIN);
    const list = await get(t.app, '/v1/admin/users', { authorization: `Bearer ${adminToken}` });
    expect(list.status).toBe(200);
    const usersList = ((await list.json()) as { users: Array<{ id: string; email: string; status: string }> }).users;
    const member = usersList.find((u) => u.email === email)!;
    expect(member.status).toBe('pending');
    // member cannot use admin endpoints
    expect((await get(t.app, '/v1/admin/users', { authorization: `Bearer ${token}` })).status).toBe(403);
    const approve = await post(t.app, `/v1/admin/users/${member.id}/approve`, {}, { authorization: `Bearer ${adminToken}` });
    expect(approve.status).toBe(200);
    expect(t.mailer.last(email)?.subject).toMatch(/approved/);

    // approved member can ask; answer is plain text with a source
    const ask = await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What does it eat?' }, { authorization: `Bearer ${token}` });
    expect(ask.status).toBe(200);
    const answer = (await ask.json()) as { answer: string; source: { url: string } };
    expect(answer.answer).toBe('A plain answer from the source text.');
    expect(answer.source.url).toContain('Turdus_merula');
    expect(t.modelCalls[0].prompt).toContain('<source>');

    // refresh and logout
    const refresh = await post(t.app, '/v1/auth/refresh', {}, { authorization: `Bearer ${token}` });
    expect(refresh.status).toBe(200);
    expect(((await refresh.json()) as { expiresAt: string }).expiresAt).toMatch(/^\d{4}-/);
    expect((await post(t.app, '/v1/auth/logout', {}, { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await get(t.app, '/v1/me', { authorization: `Bearer ${token}` })).status).toBe(401);

    // disabling revokes sessions and blocks login after the password step
    const token2 = await signUpAndLogin(t, email);
    expect((await get(t.app, '/v1/me', { authorization: `Bearer ${token2}` })).status).toBe(200);
    expect((await post(t.app, `/v1/admin/users/${member.id}/disable`, {}, { authorization: `Bearer ${adminToken}` })).status).toBe(200);
    expect((await get(t.app, '/v1/me', { authorization: `Bearer ${token2}` })).status).toBe(401);
    expect((await post(t.app, '/v1/auth/login', { email, password })).status).toBe(403);
  });

  it('burns a challenge after too many wrong codes', async () => {
    const t = await buildTestApp();
    const email = 'brute@example.com';
    await post(t.app, '/v1/auth/signup', { email, password: 'correct horse battery staple' });
    const li = await post(t.app, '/v1/auth/login', { email, password: 'correct horse battery staple' });
    const { challenge } = (await li.json()) as { challenge: string };
    const code = codeFrom(t.mailer, email);
    for (let i = 0; i < 5; i++) await post(t.app, '/v1/auth/verify', { challenge, code: '999999' });
    expect((await post(t.app, '/v1/auth/verify', { challenge, code })).status).toBe(401);
  });

  it('rate-limits rapid auth requests per IP', async () => {
    const t = await buildTestApp({ limits: { ipPerWindow: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(t.app, '/v1/auth/login', { email: 'x@example.com', password: 'whatever password!' }, { 'x-real-ip': '203.0.113.9' })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    // another IP is unaffected
    expect((await post(t.app, '/v1/auth/login', { email: 'x@example.com', password: 'whatever password!' }, { 'x-real-ip': '203.0.113.10' })).status).toBe(401);
  });

  it('enforces CORS for the configured origin only, with Vary: Origin and no credentials', async () => {
    const t = await buildTestApp();
    const ok = await t.app.request('/v1/auth/login', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
    expect(ok.headers.get('access-control-allow-headers')?.toLowerCase()).toBe('authorization,content-type');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    expect(ok.headers.get('vary')?.toLowerCase()).toContain('origin');
    const evil = await t.app.request('/v1/auth/login', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const plain = await get(t.app, '/v1/me', { origin: 'https://evil.example' });
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects oversized bodies with 413 and non-JSON with 400', async () => {
    const t = await buildTestApp();
    const big = await t.app.request('/v1/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email: 'a@b.co', password: 'p'.repeat(20_000) }) });
    expect(big.status).toBe(413);
    const text = await t.app.request('/v1/auth/signup', { method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: 'hello' });
    expect(text.status).toBe(400);
  });

  it('answers 502 for /v1/ask when no model key is configured, and health needs nothing', async () => {
    const t = await buildTestApp({ model: null });
    const token = await signUpAndLogin(t, ADMIN);
    expect((await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'Why?' }, { authorization: `Bearer ${token}` })).status).toBe(502);
    const h = await t.app.request('/health');
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true });
  });
});
