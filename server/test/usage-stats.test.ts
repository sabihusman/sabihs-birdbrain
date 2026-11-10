import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildReport, createUsageStats, DAYS_QUERY, rangeFilter, usageConfigFrom, usageQueries, USAGE_RANGES, type UsageConfig } from '../src/usage-stats.js';
import { ADMIN, approvedMember, bearer, buildTestApp, get, signUpAndLogin } from './helpers.js';

const CFG: UsageConfig = { key: 'phx_test_key', projectId: '456272', host: 'https://us.posthog.com' };
const NOW = new Date('2026-11-10T18:00:00Z');

/** A PostHog query API stand-in: answers by the query's name, records every call. */
function fakePostHog(answers: Partial<Record<'tiles' | 'days' | 'breakdowns' | 'load', { columns: string[]; results: unknown[][] } | number>>) {
  const calls: Array<{ url: string; auth: string | null; body: { query: { kind: string; query: string }; name: string } }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as (typeof calls)[number]['body'];
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body });
    const part = body.name.replace('birdbrain-admin-usage-', '') as keyof typeof answers;
    const a = answers[part];
    if (a === undefined) return new Response('{}', { status: 200 });
    if (typeof a === 'number') return new Response('{"detail":"nope"}', { status: a });
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ANSWERS = {
  tiles: { columns: ['listens', 'stopped', 'found', 'median_listen'], results: [[84, 80, 50, 250.5]] },
  days: {
    columns: ['day', 'visitors', 'listens', 'today'],
    results: [
      ['2026-11-04', 30, 9, '2026-11-10'],
      ['2026-11-09', 40, 12, '2026-11-10'],
      ['2026-11-10', 50, 18, '2026-11-10'],
    ],
  },
  breakdowns: {
    columns: ['k', 'v', 'n'],
    results: [
      ['screen', 'listen', 212],
      ['screen', 'map', 37],
      ['layout', 'focus', 38],
      ['backend', 'webgl', 71],
      ['device', 'iOS|Safari|Mobile', 96],
      ['tz', 'America/Chicago', 88],
      ['mic', 'denied', 6],
      ['modelfail', 'true', 2],
      ['modelfail', 'false', 3],
    ],
  },
  load: { columns: ['cached', 'm'], results: [['false', 9.8], ['true', 1.6]] },
};

describe('usage stats: the questions asked', () => {
  it('only the range changes the SQL, and it is one of three fixed strings', () => {
    expect(rangeFilter('today')).toBe('toDate(timestamp) = toDate(now())');
    expect(rangeFilter('7d')).toBe('timestamp >= now() - INTERVAL 7 DAY');
    expect(rangeFilter('30d')).toBe('timestamp >= now() - INTERVAL 30 DAY');
    for (const r of USAGE_RANGES) {
      const q = usageQueries(r);
      for (const sql of [q.tiles, q.breakdowns, q.load, DAYS_QUERY]) {
        // Only our app's events, never Sabih's own use.
        expect(sql).toContain("properties.$lib = 'birdbrain-web'");
        expect(sql).toContain("properties.audience != 'admin'");
      }
      expect(q.tiles.replace(rangeFilter(r), 'R')).toBe(usageQueries('7d').tiles.replace(rangeFilter('7d'), 'R'));
    }
  });

  it('posts HogQL to the project query endpoint with the bearer key', async () => {
    const ph = fakePostHog(ANSWERS);
    const stats = createUsageStats(CFG, { fetch: ph.fetchImpl, now: () => NOW });
    await stats.report('7d');
    expect(ph.calls.map((c) => c.body.name)).toEqual(['birdbrain-admin-usage-tiles', 'birdbrain-admin-usage-days', 'birdbrain-admin-usage-breakdowns', 'birdbrain-admin-usage-load']);
    for (const c of ph.calls) {
      expect(c.url).toBe('https://us.posthog.com/api/projects/456272/query/');
      expect(c.auth).toBe('Bearer phx_test_key');
      expect(c.body.query.kind).toBe('HogQLQuery');
    }
  });
});

describe('usage stats: the report', () => {
  it('turns PostHog rows into the page’s numbers', async () => {
    const ph = fakePostHog(ANSWERS);
    const r = await createUsageStats(CFG, { fetch: ph.fetchImpl, now: () => NOW }).report('7d');
    if (!('tiles' in r)) throw new Error('not configured');
    // 30, 40 and 50 visitors on the three days with visits inside the last 7.
    expect(r.tiles).toEqual({ visitorsPerDay: 40, listens: 84, foundShare: 50 / 80, medianListenSec: 250.5 });
    expect(r.days).toHaveLength(30);
    expect(r.days.at(-1)).toEqual({ day: '2026-11-10', visitors: 50, listens: 18 });
    expect(r.days.at(-2)).toEqual({ day: '2026-11-09', visitors: 40, listens: 12 });
    expect(r.days.at(-3)).toEqual({ day: '2026-11-08', visitors: 0, listens: 0 });
    expect(r.screens).toEqual([{ value: 'listen', count: 212 }, { value: 'map', count: 37 }]);
    expect(r.devices).toEqual([{ value: 'iOS|Safari|Mobile', count: 96 }]);
    expect(r.timeZones).toEqual([{ value: 'America/Chicago', count: 88 }]);
    expect(r.micProblems).toEqual([{ value: 'denied', count: 6 }]);
    expect(r.modelFailures).toEqual({ unsupported: 2, other: 3 });
    expect(r.load).toEqual({ firstDownloadSec: 9.8, cachedSec: 1.6 });
    expect(r.failed).toEqual([]);
    expect(r.stale).toBe(false);
  });

  it('today averages only today; an empty project gives nulls, not zeros that look like data', () => {
    const today = buildReport({ range: 'today', now: NOW, tiles: ANSWERS.tiles.results.map(() => ({ listens: 18, stopped: 0, found: 0, median_listen: null })), days: [{ day: '2026-11-10', visitors: 50, listens: 18, today: '2026-11-10' }], breakdowns: [], load: [] });
    expect(today.tiles).toEqual({ visitorsPerDay: 50, listens: 18, foundShare: null, medianListenSec: null });
    const empty = buildReport({ range: '30d', now: NOW, tiles: [], days: [], breakdowns: [], load: [] });
    expect(empty.tiles).toEqual({ visitorsPerDay: null, listens: 0, foundShare: null, medianListenSec: null });
    expect(empty.load).toEqual({ firstDownloadSec: null, cachedSec: null });
  });

  it('keeps PostHog’s strings short and its numbers numbers', () => {
    const r = buildReport({ range: '7d', now: NOW, tiles: [{ listens: 'lots', stopped: 1, found: 5 }], days: [], breakdowns: [{ k: 'screen', v: `<img src=x onerror=alert(1)>${'x'.repeat(100)}`, n: '7' }], load: [] });
    expect(r.tiles.listens).toBe(0);
    expect(r.tiles.foundShare).toBe(1);
    expect(r.screens[0].value).toHaveLength(60);
    expect(r.screens[0].count).toBe(7);
  });
});

describe('usage stats: caching and failures', () => {
  it('asks PostHog once per 15 minutes per range; the daily series is shared', async () => {
    const ph = fakePostHog(ANSWERS);
    let now = NOW.getTime();
    const stats = createUsageStats(CFG, { fetch: ph.fetchImpl, now: () => new Date(now) });
    await stats.report('7d');
    await stats.report('7d');
    expect(ph.calls).toHaveLength(4);
    await stats.report('30d');
    expect(ph.calls).toHaveLength(7);
    now += 15 * 60 * 1000;
    await stats.report('7d');
    expect(ph.calls).toHaveLength(11);
  });

  it('a failed part shows as failed; a failure after a good answer serves it as stale; total failure throws', async () => {
    const lines: string[] = [];
    const partial = await createUsageStats(CFG, { fetch: fakePostHog({ ...ANSWERS, breakdowns: 500 }).fetchImpl, now: () => NOW, log: (l) => lines.push(l) }).report('7d');
    expect('failed' in partial && partial.failed).toEqual(['breakdowns']);
    expect(lines.join('\n')).toContain('HTTP 500');
    expect(lines.join('\n')).not.toContain('phx_test_key');

    let now = NOW.getTime();
    let down = false;
    const good = fakePostHog(ANSWERS);
    const flaky = (async (url: string, init: RequestInit) => (down ? new Response('', { status: 503 }) : good.fetchImpl(url, init))) as unknown as typeof fetch;
    const stats = createUsageStats(CFG, { fetch: flaky, now: () => new Date(now), log: () => undefined });
    await stats.report('7d');
    down = true;
    now += 16 * 60 * 1000;
    const stale = await stats.report('7d');
    expect('stale' in stale && stale.stale).toBe(true);
    expect('updatedAt' in stale && stale.updatedAt).toBe(NOW.toISOString());

    const dead = createUsageStats(CFG, { fetch: fakePostHog({ tiles: 401, days: 401, breakdowns: 401, load: 401 }).fetchImpl, now: () => NOW, log: () => undefined });
    await expect(dead.report('7d')).rejects.toThrow('PostHog did not answer');
  });
});

describe('usage stats: configuration and the admin route', () => {
  it('needs both the key and the project id', () => {
    const base = { POSTHOG_APP_HOST: 'https://us.posthog.com/' };
    expect(usageConfigFrom(base)).toBeNull();
    expect(usageConfigFrom({ ...base, POSTHOG_PERSONAL_API_KEY: 'k' })).toBeNull();
    expect(usageConfigFrom({ ...base, POSTHOG_PERSONAL_API_KEY: 'k', POSTHOG_PROJECT_ID: '456272' })).toEqual({ key: 'k', projectId: '456272', host: 'https://us.posthog.com' });
    expect(() => loadConfig({ ...process.env, ADMIN_EMAIL: ADMIN, BETTER_AUTH_SECRET: 'x'.repeat(40), POSTHOG_PROJECT_ID: '45; DROP' } as NodeJS.ProcessEnv)).toThrow(/POSTHOG_PROJECT_ID/);
  });

  it('is admin-only, checks the range, and says when it is not set up', async () => {
    const t = await buildTestApp({ usage: createUsageStats(CFG, { fetch: fakePostHog(ANSWERS).fetchImpl, now: () => NOW }) });
    const admin = await signUpAndLogin(t, ADMIN);
    const member = await approvedMember(t, admin, 'm@example.com');
    expect((await get(t.app, '/v1/admin/usage')).status).toBe(403);
    expect((await get(t.app, '/v1/admin/usage', bearer(member.token))).status).toBe(403);
    expect((await get(t.app, '/v1/admin/usage?range=1y', bearer(admin))).status).toBe(400);
    const ok = (await (await get(t.app, '/v1/admin/usage?range=today', bearer(admin))).json()) as { configured: boolean; range: string };
    expect(ok).toMatchObject({ configured: true, range: 'today' });
    expect(JSON.stringify(ok)).not.toContain('phx_test_key');

    const bare = await buildTestApp();
    const a2 = await signUpAndLogin(bare, ADMIN);
    expect(await (await get(bare.app, '/v1/admin/usage', bearer(a2))).json()).toEqual({ configured: false });

    const down = await buildTestApp({ usage: createUsageStats(CFG, { fetch: fakePostHog({ tiles: 500, days: 500, breakdowns: 500, load: 500 }).fetchImpl, log: () => undefined }) });
    const a3 = await signUpAndLogin(down, ADMIN);
    const res = await get(down.app, '/v1/admin/usage', bearer(a3));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'usage_unavailable' });
  });
});
