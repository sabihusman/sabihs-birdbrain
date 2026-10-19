import { ANSWER_RETRY_OUTPUT_TOKENS, type Generator } from '../ask.js';

/**
 * Ollama Cloud provider for /v1/ask (DECISIONS.md #49).
 *
 * Verified against docs.ollama.com on 2026-10-19 and live against the account
 * the same day: `POST https://ollama.com/api/chat` with
 * `Authorization: Bearer <OLLAMA_API_KEY>`, body `{ model, messages, stream: false }`;
 * the answer is read from `message.content`, the finish state from
 * `done_reason`, the token counts from `prompt_eval_count` (prompt) and
 * `eval_count` (generated). Error bodies are `{ "error": "..." }` with 400,
 * 404, 429 (rate limit), 500 and 502 documented. The docs do not enumerate
 * `done_reason` values, so only `"stop"` counts as a complete answer.
 */
export const OLLAMA_CHAT_URL = 'https://ollama.com/api/chat';
export const OLLAMA_TAGS_URL = 'https://ollama.com/api/tags';
export const DEFAULT_OLLAMA_TIMEOUT_MS = 8000;

/** The parts of a non-streaming chat response the server reads. */
export interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export type ProviderFailureKind = 'rate_limit' | 'queue_full' | 'server' | 'network' | 'timeout' | 'auth' | 'bad_request' | 'cap' | 'unknown';

/** A provider that could not answer. `kind` is for the log line; the message never carries the question. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    readonly status?: number,
  ) {
    super(status ? `${kind} (HTTP ${status})` : kind);
    this.name = 'ProviderError';
  }
}

/** Map an HTTP failure to a failure kind; the body's `error` string decides between a rate limit and a full queue. */
export function classifyHttpFailure(status: number, errorText: string | undefined): ProviderFailureKind {
  const msg = (errorText ?? '').toLowerCase();
  if (status === 429) return /queue/.test(msg) ? 'queue_full' : 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'server';
  if (/queue/.test(msg)) return 'queue_full';
  if (/limit/.test(msg)) return 'rate_limit';
  return 'bad_request';
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface OllamaOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * One chat call, no retry: the output budget is the larger of the two Gemini
 * budgets (1400) because the free plan serves one request at a time and the
 * 8 s timeout already bounds the wait. A reply that stops for any reason other
 * than "stop" is reported as cut so the chain can fall back.
 */
export function createOllamaGenerator(opts: OllamaOptions): Generator {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  return async ({ systemInstruction, prompt }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let res: Response;
    try {
      res = await doFetch(OLLAMA_CHAT_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt },
          ],
          stream: false,
          options: { temperature: 0.2, num_predict: ANSWER_RETRY_OUTPUT_TOKENS },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new ProviderError(controller.signal.aborted || (err instanceof Error && err.name === 'AbortError') ? 'timeout' : 'network');
    }
    let body: OllamaChatResponse;
    try {
      body = (await res.json()) as OllamaChatResponse;
    } catch {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ProviderError('timeout');
      if (!res.ok) throw new ProviderError(classifyHttpFailure(res.status, undefined), res.status);
      throw new ProviderError('server', res.status);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new ProviderError(classifyHttpFailure(res.status, body?.error), res.status);
    if (typeof body !== 'object' || body === null || typeof body.error === 'string') throw new ProviderError('server', res.status);
    const finish = body.done_reason ?? (body.done ? 'stop' : 'unknown');
    const total = body.prompt_eval_count !== undefined && body.eval_count !== undefined ? body.prompt_eval_count + body.eval_count : undefined;
    return {
      text: body.message?.content ?? '',
      cut: finish !== 'stop',
      usage: { promptTokens: body.prompt_eval_count, answerTokens: body.eval_count, totalTokens: total },
      model: body.model ?? opts.model,
      durationMs: Date.now() - started,
    };
  };
}
