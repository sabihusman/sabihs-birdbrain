/**
 * Admin › Usage (DECISIONS.md #121): the anonymous usage counts (#120) read back from PostHog for the admin page,
 * so Sabih never has to sign in to PostHog. The server asks PostHog's query API a few fixed HogQL questions with a
 * read-only personal API key that lives only in /opt/birdbrain/.env, and keeps each answer for 15 minutes.
 *
 * Nothing from the request reaches the SQL: the range is one of three fixed strings. PostHog's answers are external
 * data, so every value is coerced to a number or a short string before it leaves this file. The key is never logged.
 *
 * PostHog's limits (docs/api/queries, read Nov 10): 3 queries at once and, on older plans, 120 an hour; this runs
 * at most 4 one after another per range per 15 minutes (the 30-day daily series is shared), so 40 an hour at worst.
 */

export const USAGE_RANGES = ['today', '7d', '30d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export const USAGE_TTL_MS = 15 * 60 * 1000;
const QUERY_TIMEOUT_MS = 20_000;

export interface Count {
  value: string;
  count: number;
}

export interface UsageReport {
  configured: true;
  range: UsageRange;
  /** When PostHog answered (ISO). */
  updatedAt: string;
  /** True when PostHog could not be reached and this is the last good answer. */
  stale: boolean;
  tiles: {
    /** Visitors a day, averaged over the days in the range that had any; null with no visits. */
    visitorsPerDay: number | null;
    listens: number;
    /** Share of finished listens that found at least one bird, 0–1; null with none. */
    foundShare: number | null;
    medianListenSec: number | null;
  };
  /** The last 30 days, oldest first, with empty days filled in. */
  days: Array<{ day: string; visitors: number; listens: number }>;
  screens: Count[];
  layouts: Count[];
  backends: Count[];
  /** "iOS|Safari|Mobile" style keys; the page turns them into names. */
  devices: Count[];
  timeZones: Count[];
  micProblems: Count[];
  modelFailures: { unsupported: number; other: number };
  load: { firstDownloadSec: number | null; cachedSec: number | null };
  /** Parts PostHog failed to answer; their cards show "Couldn't load". */
  failed: string[];
}

export interface UsageConfig {
  key: string;
  projectId: string;
  /** PostHog's app host (not the ingestion host), e.g. https://us.posthog.com. */
  host: string;
}

export interface UsageStats {
  readonly configured: boolean;
  /** Throws `UsageUnavailableError` only when PostHog fails and nothing is cached. */
  report(range: UsageRange): Promise<UsageReport | { configured: false }>;
}

export class UsageUnavailableError extends Error {}

/** Only our app's events, and never Sabih's own use (the admin audience, #120). */
const BASE = "properties.$lib = 'birdbrain-web' AND properties.audience != 'admin'";

export function rangeFilter(range: UsageRange): string {
  if (range === 'today') return 'toDate(timestamp) = toDate(now())';
  return `timestamp >= now() - INTERVAL ${range === '7d' ? 7 : 30} DAY`;
}

/** The fixed questions. Exported for the tests, which check that nothing but the range changes them. */
export function usageQueries(range: UsageRange): { tiles: string; breakdowns: string; load: string } {
  const r = rangeFilter(range);
  const where = (event: string) => `event = '${event}' AND ${BASE} AND ${r}`;
  const part = (k: string, event: string, value: string, count = 'count()') => `SELECT '${k}' AS k, ${value} AS v, ${count} AS n FROM events WHERE ${where(event)} GROUP BY v`;
  return {
    tiles: [
      "SELECT countIf(event = 'listen_started') AS listens,",
      "countIf(event = 'listen_stopped') AS stopped,",
      "countIf(event = 'listen_stopped' AND toFloat(properties.birds) > 0) AS found,",
      "medianIf(toFloat(properties.seconds), event = 'listen_stopped') AS median_listen",
      `FROM events WHERE ${BASE} AND ${r}`,
    ].join(' '),
    breakdowns: [
      part('screen', '$pageview', 'toString(properties.page)'),
      part('layout', 'listen_started', 'toString(properties.layout)'),
      part('backend', 'model_loaded', 'toString(properties.backend)'),
      part('device', '$pageview', "concat(toString(properties.$os), '|', toString(properties.$browser), '|', toString(properties.$device_type))", 'count(DISTINCT distinct_id)'),
      part('tz', '$pageview', 'toString(properties.$timezone)', 'count(DISTINCT distinct_id)'),
      part('mic', 'mic_problem', 'toString(properties.problem)'),
      part('modelfail', 'model_failed', 'toString(properties.unsupported)'),
    ]
      .join(' UNION ALL ')
      .concat(' LIMIT 500'),
    load: `SELECT toString(properties.from_cache) AS cached, median(toFloat(properties.load_seconds)) AS m FROM events WHERE ${where('model_loaded')} GROUP BY cached LIMIT 10`,
  };
}

export const DAYS_QUERY = `SELECT toString(toDate(timestamp)) AS day, count(DISTINCT distinct_id) AS visitors, countIf(event = 'listen_started') AS listens, toString(toDate(now())) AS today FROM events WHERE ${BASE} AND timestamp >= now() - INTERVAL 30 DAY GROUP BY day ORDER BY day LIMIT 40`;

type Row = Record<string, unknown>;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string {
  return (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, 60);
}

/** One HogQL question; rows as objects keyed by PostHog's column names. */
async function query(cfg: UsageConfig, fetchImpl: typeof fetch, name: string, sql: string): Promise<Row[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUERY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${cfg.host}/api/projects/${cfg.projectId}/query/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, name: `birdbrain-admin-usage-${name}` }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // The status and PostHog's short reason, never the key or the request.
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { results?: unknown[][]; columns?: string[] };
    const cols = Array.isArray(body.columns) ? body.columns : [];
    return (Array.isArray(body.results) ? body.results : []).map((r) => Object.fromEntries(cols.map((c, i) => [c, Array.isArray(r) ? r[i] : undefined])));
  } finally {
    clearTimeout(timer);
  }
}

function lastDays(n: number, today: string): string[] {
  const out: string[] = [];
  const t = Date.parse(`${today}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Build the report from PostHog's rows; parts that failed come in as null. Pure, for the tests. */
export function buildReport(o: { range: UsageRange; now: Date; tiles: Row[] | null; days: Row[] | null; breakdowns: Row[] | null; load: Row[] | null }): UsageReport {
  const failed: string[] = [];
  if (!o.tiles) failed.push('tiles');
  if (!o.days) failed.push('days');
  if (!o.breakdowns) failed.push('breakdowns');
  if (!o.load) failed.push('load');

  const today = str(o.days?.[0]?.today) || o.now.toISOString().slice(0, 10);
  const byDay = new Map((o.days ?? []).map((r) => [str(r.day), { visitors: num(r.visitors), listens: num(r.listens) }]));
  const days = lastDays(30, today).map((day) => ({ day, ...(byDay.get(day) ?? { visitors: 0, listens: 0 }) }));
  const inRange = days.slice(o.range === 'today' ? -1 : o.range === '7d' ? -7 : -30).filter((d) => d.visitors > 0);
  const visitorsPerDay = inRange.length ? Math.round(inRange.reduce((s, d) => s + d.visitors, 0) / inRange.length) : null;

  const t = o.tiles?.[0] ?? {};
  const stopped = num(t.stopped);
  const breakdown = (k: string): Count[] =>
    (o.breakdowns ?? [])
      .filter((r) => r.k === k)
      .map((r) => ({ value: str(r.v), count: num(r.n) }))
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count);
  const failures = breakdown('modelfail');
  const loadRow = (cached: boolean) => (o.load ?? []).find((r) => ['true', '1'].includes(str(r.cached)) === cached);

  return {
    configured: true,
    range: o.range,
    updatedAt: o.now.toISOString(),
    stale: false,
    tiles: {
      visitorsPerDay,
      listens: num(t.listens),
      foundShare: stopped > 0 ? Math.min(1, num(t.found) / stopped) : null,
      medianListenSec: stopped > 0 ? numOrNull(t.median_listen) : null,
    },
    days,
    screens: breakdown('screen'),
    layouts: breakdown('layout'),
    backends: breakdown('backend'),
    devices: breakdown('device'),
    timeZones: breakdown('tz'),
    micProblems: breakdown('mic'),
    modelFailures: {
      unsupported: failures.filter((f) => ['true', '1'].includes(f.value)).reduce((s, f) => s + f.count, 0),
      other: failures.filter((f) => !['true', '1'].includes(f.value)).reduce((s, f) => s + f.count, 0),
    },
    load: { firstDownloadSec: numOrNull(loadRow(false)?.m), cachedSec: numOrNull(loadRow(true)?.m) },
    failed,
  };
}

export function createUsageStats(cfg: UsageConfig | null, opts: { fetch?: typeof fetch; now?: () => Date; ttlMs?: number; log?: (line: string) => void } = {}): UsageStats {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const ttl = opts.ttlMs ?? USAGE_TTL_MS;
  const log = opts.log ?? ((line) => console.warn(line));
  const cache = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();

  /** One cached question: fresh for the TTL; on failure the last good answer (stale) or null. */
  async function cached(key: string, name: string, sql: string): Promise<{ rows: Row[] | null; stale: boolean; at: number | null }> {
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < ttl) return { rows: hit.value as Row[], stale: false, at: hit.at };
    let p = inflight.get(key) as Promise<Row[]> | undefined;
    if (!p) {
      p = query(cfg!, fetchImpl, name, sql);
      inflight.set(key, p);
    }
    try {
      const rows = await p;
      const at = now().getTime();
      cache.set(key, { at, value: rows });
      return { rows, stale: false, at };
    } catch (e) {
      log(`[usage] PostHog query ${name} failed: ${(e as Error).message}`);
      return hit ? { rows: hit.value as Row[], stale: true, at: hit.at } : { rows: null, stale: false, at: null };
    } finally {
      inflight.delete(key);
    }
  }

  return {
    configured: cfg !== null,
    async report(range) {
      if (!cfg) return { configured: false };
      const q = usageQueries(range);
      // One after another: PostHog runs at most three at once per project.
      const tiles = await cached(`tiles:${range}`, 'tiles', q.tiles);
      const days = await cached('days', 'days', DAYS_QUERY);
      const breakdowns = await cached(`breakdowns:${range}`, 'breakdowns', q.breakdowns);
      const load = await cached(`load:${range}`, 'load', q.load);
      const parts = [tiles, days, breakdowns, load];
      if (parts.every((p) => p.rows === null)) throw new UsageUnavailableError('PostHog did not answer');
      const report = buildReport({ range, now: now(), tiles: tiles.rows, days: days.rows, breakdowns: breakdowns.rows, load: load.rows });
      const oldest = Math.min(...parts.map((p) => p.at ?? now().getTime()));
      return { ...report, updatedAt: new Date(oldest).toISOString(), stale: parts.some((p) => p.stale) };
    },
  };
}

/** From the server's environment; null (page says "not set up") unless both the key and the project id are set. */
export function usageConfigFrom(env: { POSTHOG_PERSONAL_API_KEY?: string; POSTHOG_PROJECT_ID?: string; POSTHOG_APP_HOST: string }): UsageConfig | null {
  if (!env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return null;
  return { key: env.POSTHOG_PERSONAL_API_KEY, projectId: env.POSTHOG_PROJECT_ID, host: env.POSTHOG_APP_HOST.replace(/\/+$/, '') };
}
