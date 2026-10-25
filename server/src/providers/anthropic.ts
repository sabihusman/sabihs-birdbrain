import Anthropic from '@anthropic-ai/sdk';
import type { Generator } from '../ask.js';
import { ProviderError, type ProviderFailureKind } from './ollama.js';

/**
 * Anthropic (Claude) provider for /v1/ask (DECISIONS.md #91), through the official SDK
 * (`@anthropic-ai/sdk`, pinned). The model comes from `ANTHROPIC_MODEL` in `.env`; nothing here names one.
 *
 * One `messages.create` call, no SDK retry (`maxRetries: 0`): the chain falls back to the next provider
 * instead, so a slow or failing call never multiplies the wait. Thinking is left at the model's default
 * (adaptive on current models) with `effort: "low"`, the documented setting for short chat-style answers;
 * `max_tokens` leaves room for that thinking on top of the answer, whose length the prompt already limits.
 *
 * Outcome mapping: `end_turn` / `stop_sequence` is a complete answer; `max_tokens` (or the context limit)
 * is a cut answer, so the chain falls back or marks it as before (#43); `refusal` is a failure of kind
 * `refused`, so the chain asks the next provider. Server-side refusal fallback (`fallbacks`) is not used:
 * on Sonnet 5.5 it only retries cyber and frontier-LLM declines, which bird questions never hit, and the
 * chain already covers every refusal.
 */
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 20_000;
export const ANTHROPIC_MAX_TOKENS = 4000;
export const ANTHROPIC_EFFORT = 'low' as const;

/** The one SDK call the provider makes; tests pass a fake. */
export interface AnthropicMessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message> };
}

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  client?: AnthropicMessagesClient;
}

export function createAnthropicGenerator(opts: AnthropicOptions): Generator {
  const client: AnthropicMessagesClient = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS, maxRetries: 0 });
  return async ({ systemInstruction, prompt }) => {
    const started = Date.now();
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create({
        model: opts.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: systemInstruction,
        messages: [{ role: 'user', content: prompt }],
        output_config: { effort: ANTHROPIC_EFFORT },
      });
    } catch (err) {
      throw new ProviderError(classifyAnthropicError(err), err instanceof Anthropic.APIError ? err.status : undefined);
    }
    // Check the stop reason before reading the content: a refusal is a normal 200 response.
    if (msg.stop_reason === 'refusal') throw new ProviderError('refused');
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const u = msg.usage;
    const promptTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    return {
      text,
      cut: msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded',
      // output_tokens includes the thinking tokens, which are billed as output.
      usage: { promptTokens, answerTokens: u.output_tokens, totalTokens: promptTokens + u.output_tokens },
      model: msg.model,
      durationMs: Date.now() - started,
    };
  };
}

/** The SDK's typed errors, most specific first (APIConnectionTimeoutError is an APIConnectionError, which is an APIError). */
export function classifyAnthropicError(err: unknown): ProviderFailureKind {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.APIConnectionError) return 'network';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limit';
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'auth';
  // 500, and 529 "overloaded_error".
  if (err instanceof Anthropic.InternalServerError) return 'server';
  if (err instanceof Anthropic.APIError) return err.status === 402 ? 'billing' : 'bad_request';
  return 'unknown';
}
