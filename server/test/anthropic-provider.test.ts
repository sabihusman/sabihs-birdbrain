import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { SYSTEM_INSTRUCTION } from '../src/ask.js';
import { ANTHROPIC_EFFORT, ANTHROPIC_MAX_TOKENS, classifyAnthropicError, createAnthropicGenerator, type AnthropicMessagesClient } from '../src/providers/anthropic.js';
import { aiServiceLabels, createProviderChain } from '../src/providers/index.js';
import { ProviderError } from '../src/providers/ollama.js';
import { anthropicCostMicros } from '../src/pricing.js';
import { FakeGemini } from './fake-gemini.js';
import { openDatabase } from '../src/db.js';
import { createProviderUsageStore } from '../src/provider-usage.js';
import { ADMIN, approvedMember, bearer, buildTestApp, get, post, signUpAndLogin, testConfig } from './helpers.js';

const input = { systemInstruction: SYSTEM_INSTRUCTION, prompt: '<source>[Section: Range]\nBreeds in the north.</source>\nQUESTION: Where does it breed?' };

/** A fake SDK client: records each request and answers with the next scripted message or error. */
class FakeAnthropic implements AnthropicMessagesClient {
  calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private script: Array<Partial<Anthropic.Message> | Error>) {}
  messages = {
    create: async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      this.calls.push(params);
      const next = this.script.shift() ?? reply('ok');
      if (next instanceof Error) throw next;
      return next as Anthropic.Message;
    },
  };
}

function reply(text: string, stop: Anthropic.StopReason = 'end_turn', usage: Partial<Anthropic.Usage> = {}): Partial<Anthropic.Message> {
  return {
    model: 'claude-test',
    // An empty thinking block first, as adaptive thinking with the default display returns it.
    content: [{ type: 'thinking', thinking: '', signature: 's' } as unknown as Anthropic.ContentBlock, { type: 'text', text, citations: null } as Anthropic.TextBlock],
    stop_reason: stop,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } as Anthropic.Usage,
  };
}

const headers = new Headers();

describe('Anthropic provider (DECISIONS.md #91)', () => {
  it('sends the system prompt and question with the configured model, low effort and room for thinking, and reads only the text', async () => {
    const fake = new FakeAnthropic([reply('Breeds in the north [Wikipedia].', 'end_turn', { cache_read_input_tokens: 100 })]);
    const out = await createAnthropicGenerator({ apiKey: 'k', model: 'model-from-env', client: fake })(input);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ model: 'model-from-env', max_tokens: ANTHROPIC_MAX_TOKENS, system: SYSTEM_INSTRUCTION, messages: [{ role: 'user', content: input.prompt }], output_config: { effort: ANTHROPIC_EFFORT } });
    expect(ANTHROPIC_EFFORT).toBe('low');
    expect(out).toMatchObject({ text: 'Breeds in the north [Wikipedia].', cut: false, model: 'claude-test', usage: { promptTokens: 1300, answerTokens: 300, totalTokens: 1600 } });
  });

  it('reports a max_tokens stop as cut and a refusal as a failure for the chain', async () => {
    expect((await createAnthropicGenerator({ apiKey: 'k', model: 'm', client: new FakeAnthropic([reply('Half an ans', 'max_tokens')]) })(input)).cut).toBe(true);
    await expect(createAnthropicGenerator({ apiKey: 'k', model: 'm', client: new FakeAnthropic([reply('', 'refusal')]) })(input)).rejects.toMatchObject({ kind: 'refused' });
  });

  it('maps the SDK errors to failure kinds, most specific first', async () => {
    expect(classifyAnthropicError(new Anthropic.APIConnectionTimeoutError())).toBe('timeout');
    expect(classifyAnthropicError(new Anthropic.APIConnectionError({ message: 'down' }))).toBe('network');
    expect(classifyAnthropicError(new Anthropic.RateLimitError(429, {}, 'slow down', headers))).toBe('rate_limit');
    expect(classifyAnthropicError(new Anthropic.AuthenticationError(401, {}, 'bad key', headers))).toBe('auth');
    expect(classifyAnthropicError(new Anthropic.PermissionDeniedError(403, {}, 'no', headers))).toBe('auth');
    expect(classifyAnthropicError(new Anthropic.InternalServerError(529, {}, 'overloaded', headers))).toBe('server');
    expect(classifyAnthropicError(new Anthropic.APIError(402, {}, 'billing', headers))).toBe('billing');
    expect(classifyAnthropicError(new Anthropic.BadRequestError(400, {}, 'bad', headers))).toBe('bad_request');
    expect(classifyAnthropicError(new Error('?'))).toBe('unknown');
    const failing = createAnthropicGenerator({ apiKey: 'k', model: 'm', client: new FakeAnthropic([new Anthropic.RateLimitError(429, {}, 'slow down', headers)]) });
    const err = await failing(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'rate_limit', status: 429 });
  });

  it('is skipped without a key, refused as a configuration without a model, and named "Anthropic Claude"', () => {
    const lines: string[] = [];
    expect(createProviderChain(testConfig({ AI_PROVIDER_ORDER: 'anthropic' }), { log: (l) => lines.push(l) })).toBeNull();
    expect(lines).toEqual(['[startup] ANTHROPIC_API_KEY not set: Anthropic provider skipped']);
    expect(() => testConfig({ ANTHROPIC_API_KEY: 'k', AI_PROVIDER_ORDER: 'anthropic' })).toThrow(/ANTHROPIC_MODEL is required/);
    expect(aiServiceLabels(testConfig({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm', GEMINI_API_KEY: 'g', AI_PROVIDER_ORDER: 'anthropic,gemini' }))).toEqual(['Anthropic Claude', 'Google Gemini']);
  });

  it('answers first in the chain, and a refusal falls back to Gemini with one log line naming the reason', async () => {
    const lines: string[] = [];
    const gemini = new FakeGemini();
    const config = testConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-secret', ANTHROPIC_MODEL: 'model-from-env', GEMINI_API_KEY: 'g', GEMINI_MODEL: 'gemini-test', AI_PROVIDER_ORDER: 'anthropic,gemini' });
    const ok = createProviderChain(config, { anthropicClient: new FakeAnthropic([reply('From Claude.')]), geminiClient: gemini, log: (l) => lines.push(l) })!;
    expect(lines.at(-1)).toBe('[startup] /v1/ask providers: anthropic (model-from-env) -> gemini (gemini-test)');
    expect(await ok(input)).toBe('From Claude.');
    expect(lines.at(-1)).toMatch(/^\[ask\] provider=anthropic model=claude-test fallback_from=- /);

    const refused = createProviderChain(config, { anthropicClient: new FakeAnthropic([reply('', 'refusal')]), geminiClient: gemini, log: (l) => lines.push(l) })!;
    const answer = await refused(input);
    expect(answer.length).toBeGreaterThan(0);
    expect(lines).toContain('[ask] provider=anthropic failed reason=refused (falling back)');
    expect(lines.at(-1)).toMatch(/provider=gemini .*fallback_from=anthropic fallback_reason=refused/);
    // The key never reaches a log line.
    expect(lines.join('\n')).not.toContain('sk-ant-test-secret');
  });

  it('estimates the cost from token totals at the listed price, and gives none for an unlisted model', () => {
    // Sonnet 5.5: $2 in, $10 out per million tokens (pricing page, 2026-10-25).
    expect(anthropicCostMicros('claude-sonnet-5-5', 1_000_000, 100_000)).toBe(3_000_000);
    expect(anthropicCostMicros('claude-unlisted', 10, 10)).toBeNull();
    expect(anthropicCostMicros(undefined, 10, 10)).toBeNull();
  });

  it('answers /v1/ask through Claude end to end and the admin summary shows its estimated cost', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test-secret', ANTHROPIC_MODEL: 'claude-sonnet-5-5', AI_PROVIDER_ORDER: 'anthropic' };
    const providerUsage = createProviderUsageStore(openDatabase(':memory:'));
    const model = createProviderChain(testConfig(env), { anthropicClient: new FakeAnthropic([reply('Breeds in the north [Wikipedia].', 'end_turn', { input_tokens: 2000, output_tokens: 500 })]), log: () => undefined, providerUsage })!;
    const t = await buildTestApp({ model, env, providerUsage, limits: { askPerMinute: 1000 } });
    const admin = await signUpAndLogin(t, ADMIN);
    const member = await approvedMember(t, admin, 'm@example.com');
    const res = await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'Where does it breed?' }, bearer(member.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answer: string }).answer).toContain('Breeds in the north');
    const summary = (await (await get(t.app, '/v1/admin/ask-costs', bearer(admin))).json()) as Record<string, unknown>;
    expect(summary.models).toMatchObject({ anthropic: 'claude-sonnet-5-5' });
    // 2,000 prompt tokens at $2/M + 500 answer tokens at $10/M = $0.009.
    expect(summary.estimates).toEqual({ anthropic: 9000 });
    expect((await (await get(t.app, '/v1/ai-services')).json()) as unknown).toEqual({ services: ['Anthropic Claude'] });
  });
});
