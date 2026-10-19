/**
 * Per-day totals of what /v1/ask spends: token counts, estimated cost and
 * answer-cache hits, one SQLite row per UTC day. Never any question text.
 */
import type { DatabaseSync } from 'node:sqlite';
import { utcDay } from './db.js';
import { cappedCostMicros, formatUsd, type PriceOverrides, type TokenUsage } from './pricing.js';

export interface AskCostDay {
  day: string;
  /** Billed model calls (a retry after MAX_TOKENS counts as a second call). */
  requests: number;
  promptTokens: number;
  answerTokens: number;
  thinkingTokens: number;
  /** Prompt tokens Gemini reported as cache hits. */
  cachedTokens: number;
  /** Estimated cost in micro-dollars over the priced calls. */
  costMicros: number;
  /** Calls to a model with no price in the table; their tokens are counted, their cost is not. */
  unpricedRequests: number;
  /** Answers served from the answer cache (no model call). */
  cacheHits: number;
}

/** Which cap alerts have gone out this month: 50 and/or 100 (percent of the cap). */
export type CapAlertLevel = 50 | 100;

export interface MonthStatus {
  /** "YYYY-MM" in UTC. */
  month: string;
  spentMicros: number;
  capMicros: number;
  /** Whole percent of the cap spent (can exceed 100). */
  percent: number;
  alertsSent: CapAlertLevel[];
}

export interface AskCostStore {
  /**
   * One billed model call. Returns the estimated cost in micro-dollars. Since
   * the monthly cap (#53) every Gemini call is priced, unknown models at the
   * most expensive known price, so `unpricedRequests` stays 0 from then on.
   */
  record(model: string, usage: TokenUsage, now?: Date): number;
  recordCacheHit(now?: Date): void;
  /** The last `days` UTC days that have a row, newest first. */
  summary(days?: number, now?: Date): AskCostDay[];
  /** Estimated spend in micro-dollars over the UTC calendar month of `now`. */
  monthSpendMicros(now?: Date): number;
  /** Spend, cap and alerts for the month of `now`. */
  monthStatus(capMicros: number, now?: Date): MonthStatus;
  /** Records that the alert for `level` went out this month; false when it already had. */
  markAlert(level: CapAlertLevel, now?: Date): boolean;
}

/** "YYYY-MM" of a date in UTC. */
export function utcMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export const COST_SUMMARY_DAYS = 30;

export function createAskCostStore(db: DatabaseSync, opts: { priceOverrides?: PriceOverrides } = {}): AskCostStore {
  const overrides = opts.priceOverrides ?? {};
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_cost_alert (
      month TEXT NOT NULL,
      level INTEGER NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (month, level)
    );
    CREATE TABLE IF NOT EXISTS ask_cost (
      day TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      answer_tokens INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      unpriced_requests INTEGER NOT NULL DEFAULT 0,
      cache_hits INTEGER NOT NULL DEFAULT 0
    );
  `);
  const add = db.prepare(`
    INSERT INTO ask_cost (day, requests, prompt_tokens, answer_tokens, thinking_tokens, cached_tokens, cost_micros, unpriced_requests, cache_hits)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(day) DO UPDATE SET
      requests = requests + 1,
      prompt_tokens = prompt_tokens + excluded.prompt_tokens,
      answer_tokens = answer_tokens + excluded.answer_tokens,
      thinking_tokens = thinking_tokens + excluded.thinking_tokens,
      cached_tokens = cached_tokens + excluded.cached_tokens,
      cost_micros = cost_micros + excluded.cost_micros,
      unpriced_requests = unpriced_requests + excluded.unpriced_requests
  `);
  const hit = db.prepare('INSERT INTO ask_cost (day, cache_hits) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET cache_hits = cache_hits + 1');
  const list = db.prepare('SELECT * FROM ask_cost WHERE day >= ? ORDER BY day DESC');
  const monthSum = db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS micros FROM ask_cost WHERE day >= ? AND day < ?');
  const alertsFor = db.prepare('SELECT level FROM ask_cost_alert WHERE month = ? ORDER BY level');
  const insertAlert = db.prepare('INSERT OR IGNORE INTO ask_cost_alert (month, level, sent_at) VALUES (?, ?, ?)');
  const monthRange = (now: Date): [string, string] => {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return [`${utcMonth(now)}-01`, utcDay(next)];
  };
  const monthSpendMicros = (now = new Date()): number => {
    const [from, to] = monthRange(now);
    return Number((monthSum.get(from, to) as { micros: number }).micros);
  };
  return {
    record(model, usage, now = new Date()) {
      const cost = cappedCostMicros(model, usage, overrides);
      add.run(utcDay(now), usage.promptTokens, usage.answerTokens, usage.thinkingTokens, usage.cachedTokens, cost, 0);
      return cost;
    },
    monthSpendMicros,
    monthStatus(capMicros, now = new Date()) {
      const spentMicros = monthSpendMicros(now);
      const alertsSent = (alertsFor.all(utcMonth(now)) as Array<{ level: number }>).map((r) => Number(r.level) as CapAlertLevel);
      return { month: utcMonth(now), spentMicros, capMicros, percent: capMicros > 0 ? Math.floor((spentMicros * 100) / capMicros) : 100, alertsSent };
    },
    markAlert(level, now = new Date()) {
      return Number(insertAlert.run(utcMonth(now), level, now.toISOString()).changes) === 1;
    },
    recordCacheHit(now = new Date()) {
      hit.run(utcDay(now));
    },
    summary(days = COST_SUMMARY_DAYS, now = new Date()) {
      const from = utcDay(new Date(now.getTime() - (days - 1) * 86_400_000));
      type Row = { day: string; requests: number; prompt_tokens: number; answer_tokens: number; thinking_tokens: number; cached_tokens: number; cost_micros: number; unpriced_requests: number; cache_hits: number };
      return (list.all(from) as Row[]).map((r) => ({
        day: r.day,
        requests: Number(r.requests),
        promptTokens: Number(r.prompt_tokens),
        answerTokens: Number(r.answer_tokens),
        thinkingTokens: Number(r.thinking_tokens),
        cachedTokens: Number(r.cached_tokens),
        costMicros: Number(r.cost_micros),
        unpricedRequests: Number(r.unpriced_requests),
        cacheHits: Number(r.cache_hits),
      }));
    },
  };
}

/** The cost fields appended to the `[ask]` log line (token counts only, never text). */
export function describeCost(cost: number | null): string {
  return `cost_usd=${formatUsd(cost)} cached=false`;
}

/** The whole `[ask]` line for an answer served from the answer cache. */
export const CACHE_HIT_LOG_LINE = '[ask] attempt=0 finish=CACHE prompt_tokens=0 answer_tokens=0 thinking_tokens=0 total_tokens=0 cost_usd=0.000000 cached=true';
