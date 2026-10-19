import { finishCutAnswer, type AnswerModel, type GenAiClient, type GeneratedAnswer, type Generator } from '../ask.js';
import type { AskCostStore } from '../ask-cost.js';
import type { Config, ProviderName } from '../config.js';
import type { ProviderUsageStore } from '../provider-usage.js';
import { createGeminiProvider } from './gemini.js';
import { createOllamaGenerator, ProviderError, type FetchLike, type ProviderFailureKind } from './ollama.js';

/** One provider in the chain: a name for the log and a generator with the shared prompt contract. */
export interface AnswerProvider {
  name: ProviderName;
  generate: Generator;
}

export type FallbackReason = ProviderFailureKind | 'empty' | 'cut_off';

export interface ChainOptions {
  log?: (line: string) => void;
  /** Per-provider daily totals; the running day totals go on the log line. */
  providerUsage?: ProviderUsageStore;
}

/**
 * Try the providers in order; fall back on any failure (rate limit, full
 * queue, 5xx, network error, timeout, bad key), an empty reply or an answer
 * cut at the output limit. The last provider's cut answer is kept and marked
 * "(answer cut short)" as before (#43). If every provider fails the chain
 * throws, which `answerQuestion` turns into the existing 502
 * `model_unavailable`; members never see a provider error. One `[ask]` line
 * per request names the provider and model that answered, the providers it
 * fell back from, the token counts, the wall time and the provider's running
 * totals for the UTC day; never the question or the answer.
 */
export function createChain(providers: AnswerProvider[], opts: ChainOptions = {}): AnswerModel {
  const log = opts.log ?? ((line: string) => console.info(line));
  if (providers.length === 0) throw new Error('createChain: no providers');
  return async (input) => {
    const fallbackFrom: ProviderName[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const last = i === providers.length - 1;
      let reason: FallbackReason | undefined;
      let answer: GeneratedAnswer | undefined;
      try {
        answer = await p.generate(input);
        if (!answer.text.trim()) reason = 'empty';
        else if (answer.cut && !last) reason = 'cut_off';
      } catch (err) {
        reason = err instanceof ProviderError ? err.kind : 'unknown';
      }
      if (reason === undefined && answer) {
        const u = answer.usage;
        const day = opts.providerUsage?.record(p.name, fallbackFrom, u);
        const dayPart = day ? ` day_requests=${day.requests} day_prompt_tokens=${day.promptTokens} day_answer_tokens=${day.answerTokens} day_fallbacks=${day.fallbacks}` : '';
        log(`[ask] provider=${p.name} model=${answer.model} fallback_from=${fallbackFrom.length ? fallbackFrom.join(',') : '-'} fallback_reason=${reasons.length ? reasons.join(',') : '-'} finish=${answer.cut ? 'cut' : 'stop'} prompt_tokens=${u.promptTokens ?? '-'} answer_tokens=${u.answerTokens ?? '-'} total_tokens=${u.totalTokens ?? '-'} duration_ms=${answer.durationMs}${dayPart}`);
        return answer.cut ? finishCutAnswer(answer.text) : answer.text;
      }
      log(`[ask] provider=${p.name} failed reason=${reason}${last ? ' (no provider left)' : ' (falling back)'}`);
      fallbackFrom.push(p.name);
      reasons.push(reason ?? 'unknown');
    }
    throw new ProviderError('unknown');
  };
}

export interface ChainDeps {
  fetch?: FetchLike;
  geminiClient?: GenAiClient;
  log?: (line: string) => void;
  /** Gemini's billed calls and estimated spend (#48). */
  costs?: AskCostStore;
  providerUsage?: ProviderUsageStore;
}

export type ChainConfig = Pick<Config, 'providerOrder' | 'OLLAMA_API_KEY' | 'OLLAMA_MODEL' | 'OLLAMA_TIMEOUT_MS' | 'GEMINI_API_KEY' | 'GEMINI_MODEL'>;

/** The providers the configuration enables, in order; a provider without its key is skipped with one startup line. */
export function configuredProviders(config: ChainConfig, deps: ChainDeps = {}): AnswerProvider[] {
  const log = deps.log ?? ((line: string) => console.info(line));
  const providers: AnswerProvider[] = [];
  for (const name of config.providerOrder) {
    if (name === 'ollama') {
      if (!config.OLLAMA_API_KEY) {
        log('[startup] OLLAMA_API_KEY not set: Ollama provider skipped');
        continue;
      }
      providers.push({ name, generate: createOllamaGenerator({ apiKey: config.OLLAMA_API_KEY, model: config.OLLAMA_MODEL, timeoutMs: config.OLLAMA_TIMEOUT_MS, fetch: deps.fetch }) });
    } else if (name === 'gemini') {
      if (!config.GEMINI_API_KEY) {
        log('[startup] GEMINI_API_KEY not set: Gemini provider skipped');
        continue;
      }
      providers.push({ name, generate: createGeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL, deps.geminiClient, log, deps.costs) });
    }
  }
  return providers;
}

/** Build the configured chain; null when no provider has a key, so /v1/ask answers 502 as it did without `GEMINI_API_KEY`. */
export function createProviderChain(config: ChainConfig, deps: ChainDeps = {}): AnswerModel | null {
  const log = deps.log ?? ((line: string) => console.info(line));
  const providers = configuredProviders(config, deps);
  if (providers.length === 0) return null;
  log(`[startup] /v1/ask providers: ${providers.map((p) => `${p.name} (${p.name === 'ollama' ? config.OLLAMA_MODEL : config.GEMINI_MODEL})`).join(' -> ')}`);
  return createChain(providers, { log, providerUsage: deps.providerUsage });
}
