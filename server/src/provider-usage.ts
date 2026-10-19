/**
 * Per-provider, per-UTC-day totals for /v1/ask (DECISIONS.md #49): how many
 * answers each provider gave, their token counts and how often it was reached
 * by falling back. Next to `ask_cost` (#48), which keeps Gemini's billed calls
 * and estimated spend. Never any question text.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderUsage } from './ask.js';
import type { ProviderName } from './config.js';
import { utcDay } from './db.js';

export interface ProviderDayUsage {
  day: string;
  provider: ProviderName;
  /** Answers this provider produced (one per request it answered). */
  requests: number;
  promptTokens: number;
  answerTokens: number;
  /** Requests this provider answered after an earlier provider failed. */
  fallbacks: number;
}

export interface ProviderTotals {
  provider: ProviderName;
  requests: number;
  promptTokens: number;
  answerTokens: number;
  fallbacks: number;
}

export interface ProviderUsageStore {
  /** Count one answered request; returns the provider's running totals for that UTC day. */
  record(provider: ProviderName, fallbackFrom: ReadonlyArray<ProviderName>, usage: ProviderUsage, now?: Date): ProviderTotals;
  /** Per-day rows over the last `days` UTC days, newest first. */
  days(days?: number, now?: Date): ProviderDayUsage[];
  /** One row per provider over the last `days` UTC days. */
  totals(days?: number, now?: Date): ProviderTotals[];
}

export const PROVIDER_SUMMARY_DAYS = 30;

type Row = { day: string; provider: string; requests: number; prompt_tokens: number; answer_tokens: number; fallbacks: number };

export function createProviderUsageStore(db: DatabaseSync): ProviderUsageStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_provider_usage (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      answer_tokens INTEGER NOT NULL DEFAULT 0,
      fallbacks INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider)
    );
  `);
  const add = db.prepare(`
    INSERT INTO ask_provider_usage (day, provider, requests, prompt_tokens, answer_tokens, fallbacks)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(day, provider) DO UPDATE SET
      requests = requests + 1,
      prompt_tokens = prompt_tokens + excluded.prompt_tokens,
      answer_tokens = answer_tokens + excluded.answer_tokens,
      fallbacks = fallbacks + excluded.fallbacks
  `);
  const one = db.prepare('SELECT * FROM ask_provider_usage WHERE day = ? AND provider = ?');
  const list = db.prepare('SELECT * FROM ask_provider_usage WHERE day >= ? ORDER BY day DESC, provider');
  const sums = db.prepare('SELECT provider, SUM(requests) AS requests, SUM(prompt_tokens) AS prompt_tokens, SUM(answer_tokens) AS answer_tokens, SUM(fallbacks) AS fallbacks FROM ask_provider_usage WHERE day >= ? GROUP BY provider ORDER BY provider');
  const from = (days: number, now: Date) => utcDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const totalsOf = (r: Row): ProviderTotals => ({ provider: r.provider as ProviderName, requests: Number(r.requests), promptTokens: Number(r.prompt_tokens), answerTokens: Number(r.answer_tokens), fallbacks: Number(r.fallbacks) });
  return {
    record(provider, fallbackFrom, usage, now = new Date()) {
      const day = utcDay(now);
      add.run(day, provider, usage.promptTokens ?? 0, usage.answerTokens ?? 0, fallbackFrom.length ? 1 : 0);
      return totalsOf(one.get(day, provider) as Row);
    },
    days(days = PROVIDER_SUMMARY_DAYS, now = new Date()) {
      return (list.all(from(days, now)) as Row[]).map((r) => ({ day: r.day, ...totalsOf(r) }));
    },
    totals(days = PROVIDER_SUMMARY_DAYS, now = new Date()) {
      return (sums.all(from(days, now)) as Row[]).map(totalsOf);
    },
  };
}
