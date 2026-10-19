/**
 * Gemini list prices and per-model thinking levels for the ask pipeline.
 *
 * Prices: USD per 1,000,000 tokens, Standard (paid) tier, text input, from
 * https://ai.google.dev/gemini-api/docs/pricing read on 2026-10-19:
 *   gemini-3.8-flash       input $0.75, output $3.75 "(including thinking tokens)",
 *                          cached input $0.075 — all "through December 31, 2026"
 *                          ($1.50 / $7.50 / $0.15 "starting January 1, 2027").
 *   gemini-3.5-flash-lite  input $0.30, output $2.50, cached input $0.03.
 *   gemini-3.1-flash-lite  input $0.25 (text), output $1.50, cached input $0.025.
 *   gemini-2.5-flash-lite  input $0.10 (text), output $0.40, cached input $0.01.
 * The page labels every output price "(including thinking tokens)", so thinking
 * tokens are charged at the output rate. Cached-content storage fees per hour
 * apply only to explicit caches, which this server never creates.
 *
 * Thinking levels, from https://ai.google.dev/gemini-api/docs/thinking (same day):
 *   gemini-3.8-flash: low, medium, high (default medium) — no "minimal".
 *   gemini-3.5-flash-lite: minimal, low, medium, high (default minimal).
 * `thinking_level` is the field; the legacy `thinking_budget` is never sent
 * alongside it (DECISIONS.md #43).
 *
 * Model IDs confirmed on https://ai.google.dev/gemini-api/docs/models
 * ("Last updated 2026-10-13"): `gemini-3.8-flash` (Stable) and
 * `gemini-3.5-flash-lite` (Stable; "For any new projects, use our latest
 * models: 3.5 Flash-Lite or 3.8 Flash").
 */
import { ThinkingLevel } from '@google/genai';

export interface ModelPrice {
  /** USD per million uncached input tokens. */
  inputPerM: number;
  /** USD per million output tokens; thinking tokens are billed at this rate. */
  outputPerM: number;
  /** USD per million input tokens served from a cache (implicit or explicit). */
  cachedInputPerM: number;
  /** Prices valid until this ISO date (exclusive); after it the table must be revisited. */
  validThrough: string;
}

export const PRICE_DOC_URL = 'https://ai.google.dev/gemini-api/docs/pricing';
export const PRICES_VERIFIED_ON = '2026-10-19';

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'gemini-3.8-flash': { inputPerM: 0.75, outputPerM: 3.75, cachedInputPerM: 0.075, validThrough: '2026-12-31' },
  'gemini-3.5-flash-lite': { inputPerM: 0.3, outputPerM: 2.5, cachedInputPerM: 0.03, validThrough: '2026-12-31' },
  'gemini-3.1-flash-lite': { inputPerM: 0.25, outputPerM: 1.5, cachedInputPerM: 0.025, validThrough: '2026-12-31' },
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4, cachedInputPerM: 0.01, validThrough: '2026-12-31' },
};

/** The current Flash-Lite model on the models page (the eval script's second model). */
export const FLASH_LITE_MODEL = 'gemini-3.5-flash-lite';

/**
 * Lowest thinking level each model accepts (thinking page, 2026-10-19). Unknown
 * models get LOW, which every Gemini 3 text model lists.
 */
const THINKING_LEVELS: Readonly<Record<string, ThinkingLevel>> = {
  'gemini-3.8-flash': ThinkingLevel.LOW,
  'gemini-3.6-flash': ThinkingLevel.LOW,
  'gemini-3.5-flash-lite': ThinkingLevel.MINIMAL,
};

export function thinkingLevelFor(model: string): ThinkingLevel {
  return THINKING_LEVELS[model] ?? ThinkingLevel.LOW;
}

export function priceFor(model: string): ModelPrice | null {
  return PRICES[model] ?? null;
}

/** `.env` overrides for the configured model: GEMINI_PRICE_IN / GEMINI_PRICE_OUT (USD per million tokens). */
export interface PriceOverrides {
  inputPerM?: number;
  outputPerM?: number;
}

/** The most expensive known price (highest output rate, then input): what an unknown model is billed at, so the cap cannot be dodged by a renamed model. */
export function maxKnownPrice(): ModelPrice {
  const [first, ...rest] = Object.values(PRICES);
  return rest.reduce((a, b) => (b.outputPerM > a.outputPerM || (b.outputPerM === a.outputPerM && b.inputPerM > a.inputPerM) ? b : a), first);
}

/**
 * The price a Gemini call is billed at for the monthly cap (DECISIONS.md #53):
 * the table price when the model is known, else the most expensive known
 * price; `.env` overrides replace the input and/or output rate either way.
 */
export function priceForModel(model: string, overrides: PriceOverrides = {}): ModelPrice {
  const base = PRICES[model] ?? maxKnownPrice();
  const p = { ...base };
  if (overrides.inputPerM != null) {
    p.inputPerM = overrides.inputPerM;
    p.cachedInputPerM = Math.min(base.cachedInputPerM, overrides.inputPerM);
  }
  if (overrides.outputPerM != null) p.outputPerM = overrides.outputPerM;
  return p;
}

/** Cost in micro-dollars under the cap's pricing rule: never null (unknown models use the most expensive known price). */
export function cappedCostMicros(model: string, usage: TokenUsage, overrides: PriceOverrides = {}): number {
  const p = priceForModel(model, overrides);
  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  return Math.round(uncached * p.inputPerM + cached * p.cachedInputPerM + (usage.answerTokens + usage.thinkingTokens) * p.outputPerM);
}

export interface TokenUsage {
  promptTokens: number;
  answerTokens: number;
  thinkingTokens: number;
  /** Prompt tokens served from the cache (a subset of promptTokens). */
  cachedTokens: number;
}

/** Read the four counts from a Gemini usageMetadata object; missing counts are 0. */
export function usageFromMetadata(u: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number } | undefined): TokenUsage {
  return { promptTokens: u?.promptTokenCount ?? 0, answerTokens: u?.candidatesTokenCount ?? 0, thinkingTokens: u?.thoughtsTokenCount ?? 0, cachedTokens: u?.cachedContentTokenCount ?? 0 };
}

/**
 * Cost in micro-dollars (integer; one token at $X per million is X micro-dollars),
 * or null when the model has no price in the table.
 */
export function costMicros(model: string, usage: TokenUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const cached = Math.min(usage.cachedTokens, usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  return Math.round(uncached * p.inputPerM + cached * p.cachedInputPerM + (usage.answerTokens + usage.thinkingTokens) * p.outputPerM);
}

/** "0.001234" for the log line and tables; "unknown" when there is no price. */
export function formatUsd(micros: number | null): string {
  return micros === null ? 'unknown' : (micros / 1_000_000).toFixed(6);
}
