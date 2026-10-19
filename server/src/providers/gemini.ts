import { createGeminiGenerator, type GenAiClient, type Generator } from '../ask.js';
import type { AskCostStore } from '../ask-cost.js';
import { ProviderError } from './ollama.js';

/**
 * Gemini as a chain provider: the existing wrapper (`createGeminiGenerator`
 * in ask.ts, with its finish-reason retry, DECISIONS.md #43) behind the
 * provider interface. SDK errors become `ProviderError`s so the chain logs a
 * kind, never a message that could carry request details.
 */
export function createGeminiProvider(apiKey: string, model: string, client?: GenAiClient, log?: (line: string) => void, costs?: AskCostStore): Generator {
  const generate = createGeminiGenerator(apiKey, model, client, log, costs);
  return async (input) => {
    try {
      return await generate(input);
    } catch (err) {
      throw new ProviderError(classifyGeminiError(err));
    }
  };
}

/** The SDK throws ApiError with a `status`; messages are matched only for the kind. */
export function classifyGeminiError(err: unknown): ProviderError['kind'] {
  const status = typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: unknown }).status === 'number' ? (err as { status: number }).status : undefined;
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (status === 429 || /resource_exhausted|quota|rate limit|429/.test(msg)) return 'rate_limit';
  if (status === 401 || status === 403 || /api key not valid|permission_denied|unauthenticated/.test(msg)) return 'auth';
  if ((status !== undefined && status >= 500) || /unavailable|overloaded|50\d/.test(msg)) return 'server';
  if (/abort|timeout|timed out|deadline/.test(msg)) return 'timeout';
  if (/fetch failed|econnreset|enotfound|network/.test(msg)) return 'network';
  if (status !== undefined && status >= 400) return 'bad_request';
  return 'unknown';
}
