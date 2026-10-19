import { finishCutAnswer, type AnswerModel, type GenAiClient, type GeneratedAnswer, type ProviderUsage } from '../ask.js';
import type { Config, ProviderName } from '../config.js';
import { createGeminiProvider } from './gemini.js';
import { createOllamaGenerator, ProviderError, type FetchLike, type ProviderFailureKind } from './ollama.js';

/** One provider in the chain: a name for the log and a generator with the shared prompt contract. */
export interface AnswerProvider {
  name: ProviderName;
  generate: (input: { systemInstruction: string; prompt: string }) => Promise<GeneratedAnswer>;
}

export type FallbackReason = ProviderFailureKind | 'empty' | 'cut_off';

/** Records which provider answered each request (admin cost summary). Optional so unit tests can run without a database. */
export interface ProviderUsageRecorder {
  record(provider: ProviderName, fallbackFrom: ProviderName[], usage: ProviderUsage, now?: Date): void;
}

export interface ChainOptions {
  log?: (line: string) => void;
  recorder?: ProviderUsageRecorder;
}

/**
 * Try the providers in order; fall back on any failure (rate limit, full
 * queue, 5xx, network error, timeout, bad key), an empty reply or an answer
 * cut at the output limit. The last provider's cut answer is kept and marked
 * "(answer cut short)" as before (#43). If every provider fails the chain
 * throws, which `answerQuestion` turns into the existing 502
 * `model_unavailable`; members never see a provider error. One `[ask]` line
 * per request names the provider that answered, the providers it fell back
 * from and the token counts; never the question or the answer.
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
        const from = fallbackFrom.length ? fallbackFrom.join(',') : '-';
        const why = reasons.length ? reasons.join(',') : '-';
        const u = answer.usage;
        log(`[ask] provider=${p.name} fallback_from=${from} fallback_reason=${why} finish=${answer.cut ? 'cut' : 'stop'} prompt_tokens=${u.promptTokens ?? '-'} answer_tokens=${u.answerTokens ?? '-'} total_tokens=${u.totalTokens ?? '-'}`);
        opts.recorder?.record(p.name, fallbackFrom, u);
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
  recorder?: ProviderUsageRecorder;
}

/**
 * Build the configured chain. A provider without its key is skipped with one
 * startup line; with no provider left the result is null and /v1/ask answers
 * 502 as it did without `GEMINI_API_KEY`.
 */
export function createProviderChain(config: Pick<Config, 'providerOrder' | 'OLLAMA_API_KEY' | 'OLLAMA_MODEL' | 'OLLAMA_TIMEOUT_MS' | 'GEMINI_API_KEY' | 'GEMINI_MODEL'>, deps: ChainDeps = {}): AnswerModel | null {
  const log = deps.log ?? ((line: string) => console.info(line));
  const providers: AnswerProvider[] = [];
  for (const name of config.providerOrder) {
    if (name === 'ollama') {
      if (!config.OLLAMA_API_KEY) {
        log('[startup] OLLAMA_API_KEY not set: Ollama provider skipped');
        continue;
      }
      providers.push({ name, generate: createOllamaGenerator({ apiKey: config.OLLAMA_API_KEY, model: config.OLLAMA_MODEL, timeoutMs: config.OLLAMA_TIMEOUT_MS, fetch: deps.fetch, log }) });
    } else if (name === 'gemini') {
      if (!config.GEMINI_API_KEY) {
        log('[startup] GEMINI_API_KEY not set: Gemini provider skipped');
        continue;
      }
      providers.push({ name, generate: createGeminiProvider(config.GEMINI_API_KEY, config.GEMINI_MODEL, deps.geminiClient, log) });
    }
  }
  if (providers.length === 0) return null;
  log(`[startup] /v1/ask providers: ${providers.map((p) => p.name).join(' -> ')}`);
  return createChain(providers, { log, recorder: deps.recorder });
}
