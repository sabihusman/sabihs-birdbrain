import { finishCutAnswer, type AnswerModel, type GenAiClient, type GeneratedAnswer, type Generator } from '../ask.js';
import type { AskCostStore, CapAlertLevel } from '../ask-cost.js';
import { capAlertMail, createGeminiCapGuard } from '../gemini-cap.js';
import type { Mailer } from '../mailer.js';
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
  /** Gemini's billed calls and estimated spend (#48); with it the monthly cap (#53) is enforced. */
  costs?: AskCostStore;
  providerUsage?: ProviderUsageStore;
  /** For the 50 % / 100 % cap alerts to the admin; without a mailer the alerts are only logged. */
  mailer?: Mailer;
  adminEmail?: string;
  /** Test hook for the cap's clock. */
  now?: () => Date;
}

export type ChainConfig = Pick<Config, 'providerOrder' | 'OLLAMA_API_KEY' | 'OLLAMA_MODEL' | 'OLLAMA_TIMEOUT_MS' | 'GEMINI_API_KEY' | 'GEMINI_MODEL' | 'GEMINI_MONTHLY_CAP_USD'>;

/**
 * The company and service each provider stands for, as members read it in the app's privacy text and
 * How it works (`GET /v1/ai-services`). Never a model name: those live in `.env` and change with upgrades.
 */
export const PROVIDER_LABELS: Record<ProviderName, string> = {
  ollama: 'Ollama Cloud',
  gemini: 'Google Gemini',
};

function hasKey(config: Pick<Config, 'OLLAMA_API_KEY' | 'GEMINI_API_KEY'>, name: ProviderName): boolean {
  return name === 'ollama' ? Boolean(config.OLLAMA_API_KEY) : Boolean(config.GEMINI_API_KEY);
}

/** The services a question can go to, in the order they are tried: `AI_PROVIDER_ORDER` without the providers that have no key. */
export function aiServiceLabels(config: Pick<Config, 'providerOrder' | 'OLLAMA_API_KEY' | 'GEMINI_API_KEY'>): string[] {
  return config.providerOrder.filter((n) => hasKey(config, n)).map((n) => PROVIDER_LABELS[n]);
}

/** The providers the configuration enables, in order; a provider without its key is skipped with one startup line. */
export function configuredProviders(config: ChainConfig, deps: ChainDeps = {}): AnswerProvider[] {
  const log = deps.log ?? ((line: string) => console.info(line));
  const providers: AnswerProvider[] = [];
  for (const name of config.providerOrder) {
    if (!hasKey(config, name)) {
      log(`[startup] ${name === 'ollama' ? 'OLLAMA_API_KEY' : 'GEMINI_API_KEY'} not set: ${name === 'ollama' ? 'Ollama' : 'Gemini'} provider skipped`);
      continue;
    }
    if (name === 'ollama') {
      providers.push({ name, generate: createOllamaGenerator({ apiKey: config.OLLAMA_API_KEY!, model: config.OLLAMA_MODEL, timeoutMs: config.OLLAMA_TIMEOUT_MS, fetch: deps.fetch }) });
    } else if (name === 'gemini') {
      providers.push({ name, generate: geminiWithCap(config, deps, log) });
    }
  }
  return providers;
}

/** The Gemini provider behind the monthly cap guard (#53) when a cost store is present; the alert mail goes to the admin when a mailer is wired. */
function geminiWithCap(config: ChainConfig, deps: ChainDeps, log: (line: string) => void): Generator {
  const generate = createGeminiProvider(config.GEMINI_API_KEY!, config.GEMINI_MODEL, deps.geminiClient, log, deps.costs);
  const { costs, mailer, adminEmail } = deps;
  if (!costs) return generate;
  const sendAlert = mailer && adminEmail ? (level: CapAlertLevel, status: { month: string; spentMicros: number; capMicros: number }) => sendCapMail(mailer, adminEmail, level, status) : undefined;
  log(`[startup] gemini monthly cap: $${config.GEMINI_MONTHLY_CAP_USD.toFixed(2)} (GEMINI_MONTHLY_CAP_USD)`);
  return createGeminiCapGuard(generate, { costs, capUsd: config.GEMINI_MONTHLY_CAP_USD, sendAlert, log, now: deps.now });
}

async function sendCapMail(mailer: Mailer, adminEmail: string, level: CapAlertLevel, status: { month: string; spentMicros: number; capMicros: number }): Promise<void> {
  const m = capAlertMail(level, status);
  await mailer.send({ to: adminEmail, subject: `[Birdbrain] ${m.subject}`, text: m.body });
}

/** Build the configured chain; null when no provider has a key, so /v1/ask answers 502 as it did without `GEMINI_API_KEY`. */
export function createProviderChain(config: ChainConfig, deps: ChainDeps = {}): AnswerModel | null {
  const log = deps.log ?? ((line: string) => console.info(line));
  const providers = configuredProviders(config, deps);
  if (providers.length === 0) return null;
  log(`[startup] /v1/ask providers: ${providers.map((p) => `${p.name} (${p.name === 'ollama' ? config.OLLAMA_MODEL : config.GEMINI_MODEL})`).join(' -> ')}`);
  return createChain(providers, { log, providerUsage: deps.providerUsage });
}
