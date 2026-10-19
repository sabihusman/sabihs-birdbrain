/**
 * Per-day totals of what /v1/ask spends: token counts, estimated cost and
 * answer-cache hits, one SQLite row per UTC day. Never any question text.
 */
import type { DatabaseSync } from 'node:sqlite';
import { utcDay } from './db.js';
import { costMicros, formatUsd, type TokenUsage } from './pricing.js';

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

export interface AskCostStore {
  /** One billed model call. Returns the estimated cost (null when the model has no price). */
  record(model: string, usage: TokenUsage, now?: Date): number | null;
  recordCacheHit(now?: Date): void;
  /** The last `days` UTC days that have a row, newest first. */
  summary(days?: number, now?: Date): AskCostDay[];
}

export const COST_SUMMARY_DAYS = 30;

export function createAskCostStore(db: DatabaseSync): AskCostStore {
  db.exec(`
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
  return {
    record(model, usage, now = new Date()) {
      const cost = costMicros(model, usage);
      add.run(utcDay(now), usage.promptTokens, usage.answerTokens, usage.thinkingTokens, usage.cachedTokens, cost ?? 0, cost === null ? 1 : 0);
      return cost;
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
