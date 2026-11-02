import { describe, expect, it } from 'vitest';
import { WHATS_NEW_MAX_IDS } from '../src/whats-new.js';
import { ADMIN, bearer, buildTestApp, get, post, signUpAndLogin } from './helpers.js';

const stateOf = async (t: Awaited<ReturnType<typeof buildTestApp>>, token: string) => (await (await get(t.app, '/v1/me/whats-new', bearer(token))).json()) as { seen: string[]; muted: boolean };

describe("What's new memory per account (DECISIONS.md #112)", () => {
  it('starts empty, adds seen ids without duplicates, and keeps the mute switch until changed', async () => {
    const t = await buildTestApp();
    const token = await signUpAndLogin(t, 'reader@example.com');
    expect(await stateOf(t, token)).toEqual({ seen: [], muted: false });
    expect((await post(t.app, '/v1/me/whats-new', { seen: ['2026-11-birdamp'] }, bearer(token))).status).toBe(200);
    await post(t.app, '/v1/me/whats-new', { seen: ['2026-11-birdamp', '2026-12-next'] }, bearer(token));
    expect(await stateOf(t, token)).toEqual({ seen: ['2026-11-birdamp', '2026-12-next'], muted: false });
    await post(t.app, '/v1/me/whats-new', { muted: true }, bearer(token));
    await post(t.app, '/v1/me/whats-new', { seen: ['2027-01-x'] }, bearer(token));
    expect((await stateOf(t, token)).muted).toBe(true);
    await post(t.app, '/v1/me/whats-new', { muted: false }, bearer(token));
    expect((await stateOf(t, token)).muted).toBe(false);
  });

  it('works for accounts still waiting for approval, and keeps each account separate', async () => {
    const t = await buildTestApp();
    await signUpAndLogin(t, ADMIN);
    const a = await signUpAndLogin(t, 'a@example.com');
    const b = await signUpAndLogin(t, 'b@example.com');
    await post(t.app, '/v1/me/whats-new', { seen: ['2026-11-birdamp'], muted: true }, bearer(a));
    expect(await stateOf(t, b)).toEqual({ seen: [], muted: false });
  });

  it('refuses anonymous calls and anything but short lowercase ids and a boolean', async () => {
    const t = await buildTestApp();
    const token = await signUpAndLogin(t, 'strict@example.com');
    expect((await get(t.app, '/v1/me/whats-new')).status).toBe(401);
    expect((await post(t.app, '/v1/me/whats-new', { seen: ['x'] })).status).toBe(401);
    for (const body of [{ seen: ['Bad Id'] }, { seen: ['x'.repeat(41)] }, { seen: [1] }, { muted: 'yes' }, { seen: [], other: 1 }, { seen: Array.from({ length: WHATS_NEW_MAX_IDS + 1 }, (_, i) => `id-${i}`) }]) {
      expect((await post(t.app, '/v1/me/whats-new', body, bearer(token))).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(await stateOf(t, token)).toEqual({ seen: [], muted: false });
  });

  it('keeps only the newest ids within the cap', async () => {
    const t = await buildTestApp();
    const token = await signUpAndLogin(t, 'many@example.com');
    await post(t.app, '/v1/me/whats-new', { seen: Array.from({ length: WHATS_NEW_MAX_IDS }, (_, i) => `old-${i}`) }, bearer(token));
    await post(t.app, '/v1/me/whats-new', { seen: ['newest'] }, bearer(token));
    const s = await stateOf(t, token);
    expect(s.seen).toHaveLength(WHATS_NEW_MAX_IDS);
    expect(s.seen.at(-1)).toBe('newest');
    expect(s.seen).not.toContain('old-0');
  });
});
