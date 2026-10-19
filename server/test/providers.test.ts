import { describe, expect, it } from 'vitest';
import { ANSWER_RETRY_OUTPUT_TOKENS, CUT_SHORT_SUFFIX, SYSTEM_INSTRUCTION } from '../src/ask.js';
import { parseProviderOrder } from '../src/config.js';
import { createChain, createProviderChain, type AnswerProvider } from '../src/providers/index.js';
import { classifyHttpFailure, createOllamaGenerator, OLLAMA_CHAT_URL, ProviderError } from '../src/providers/ollama.js';
import { FakeGemini } from './fake-gemini.js';
import { FakeOllama } from './fake-ollama.js';
import { ADMIN, approvedMember, buildTestApp, post, signUpAndLogin, testConfig } from './helpers.js';

const input = (q: string) => ({ systemInstruction: SYSTEM_INSTRUCTION, prompt: `<source>[Section: Range]\nBreeds in the north.</source>\nQUESTION: ${q}` });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Both providers with keys, fakes behind them, lines collected. */
function fullChain(env: Partial<NodeJS.ProcessEnv> = {}) {
  const ollama = new FakeOllama();
  const gemini = new FakeGemini();
  const lines: string[] = [];
  const config = testConfig({ OLLAMA_API_KEY: 'ollama-test-key', GEMINI_API_KEY: 'gemini-test-key', OLLAMA_MODEL: 'gpt-oss:20b', GEMINI_MODEL: 'gemini-test', ...env });
  const model = createProviderChain(config, { fetch: ollama.fetch, geminiClient: gemini, log: (l) => lines.push(l) });
  return { ollama, gemini, lines, model: model!, config };
}

describe('AI_PROVIDER_ORDER', () => {
  it('defaults to ollama then gemini, accepts any order, rejects unknown and repeated names', () => {
    expect(testConfig().providerOrder).toEqual(['ollama', 'gemini']);
    expect(parseProviderOrder('gemini, Ollama')).toEqual(['gemini', 'ollama']);
    expect(parseProviderOrder('gemini')).toEqual(['gemini']);
    expect(() => parseProviderOrder('openai,gemini')).toThrow(/unknown provider: openai/);
    expect(() => parseProviderOrder('ollama,ollama')).toThrow(/repeats ollama/);
    expect(() => parseProviderOrder(' , ')).toThrow(/empty/);
    expect(() => testConfig({ AI_PROVIDER_ORDER: 'claude' })).toThrow(/unknown provider/);
    expect(testConfig().OLLAMA_MODEL).toBe('gemma4:31b'); // the user's choice; the live .env sets it explicitly
    expect(testConfig().OLLAMA_TIMEOUT_MS).toBe(8000);
  });

  it('skips a provider without its key with one startup line, and is null with no key at all', () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(createProviderChain(testConfig(), { log })).toBeNull();
    expect(lines).toEqual(['[startup] OLLAMA_API_KEY not set: Ollama provider skipped', '[startup] GEMINI_API_KEY not set: Gemini provider skipped']);
    lines.length = 0;
    expect(createProviderChain(testConfig({ GEMINI_API_KEY: 'g' }), { log, geminiClient: new FakeGemini() })).not.toBeNull();
    expect(lines).toEqual(['[startup] OLLAMA_API_KEY not set: Ollama provider skipped', '[startup] /v1/ask providers: gemini (gemini-3.8-flash)']);
    lines.length = 0;
    expect(createProviderChain(testConfig({ OLLAMA_API_KEY: 'o', GEMINI_API_KEY: 'g', AI_PROVIDER_ORDER: 'gemini,ollama' }), { log, geminiClient: new FakeGemini() })).not.toBeNull();
    expect(lines).toEqual(['[startup] /v1/ask providers: gemini (gemini-3.8-flash) -> ollama (gemma4:31b)']);
    for (const l of lines) expect(l).not.toMatch(/[og]-key|ollama-test|gemini-test/);
  });
});

describe('Ollama Cloud request and response handling', () => {
  it('posts the documented chat request: bearer header, system + user messages, stream false, options', async () => {
    const ollama = new FakeOllama();
    const gen = createOllamaGenerator({ apiKey: 'secret-key', model: 'gpt-oss:20b', fetch: ollama.fetch });
    const r = await gen(input('What does it eat?'));
    expect(r.text).toBe('The Eurasian Blackbird eats seeds, according to the summary.');
    expect(r.cut).toBe(false);
    expect(r.usage).toEqual({ promptTokens: 1700, answerTokens: 110, totalTokens: 1810 });
    expect(r.model).toBe('fake-model'); // the name the response reports
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    const call = ollama.last;
    expect(call.url).toBe(OLLAMA_CHAT_URL);
    expect(call.url).toBe('https://ollama.com/api/chat');
    expect(call.headers.authorization).toBe('Bearer secret-key');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body.model).toBe('gpt-oss:20b');
    expect(call.body.stream).toBe(false);
    expect(call.body.messages).toEqual([
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: input('What does it eat?').prompt },
    ]);
    expect(call.body.options).toEqual({ temperature: 0.2, num_predict: ANSWER_RETRY_OUTPUT_TOKENS });
  });

  it('turns each HTTP failure into a ProviderError with the right kind', async () => {
    const ollama = new FakeOllama();
    const gen = createOllamaGenerator({ apiKey: 'k', model: 'm', fetch: ollama.fetch });
    const kinds: Array<[string, string, number | undefined]> = [
      ['rate_limit', 'rate_limit', 429],
      ['queue_full', 'queue_full', 429],
      ['server', 'server', 500],
      ['bad_gateway', 'server', 502],
      ['auth', 'auth', 401],
      ['not_json', 'server', 502],
      ['network', 'network', undefined],
    ];
    for (const [scenario, kind, status] of kinds) {
      ollama.force = scenario as FakeOllama['force'];
      const err = await gen(input('x')).catch((e: unknown) => e);
      expect(err, scenario).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind, scenario).toBe(kind);
      expect((err as ProviderError).status, scenario).toBe(status);
      expect((err as ProviderError).message).not.toMatch(/QUESTION|\bx\b/);
    }
    expect(classifyHttpFailure(429, 'usage limit reached')).toBe('rate_limit');
    expect(classifyHttpFailure(429, 'the queue is full')).toBe('queue_full');
    expect(classifyHttpFailure(503, undefined)).toBe('server');
    expect(classifyHttpFailure(400, 'invalid request')).toBe('bad_request');
    expect(classifyHttpFailure(403, 'forbidden')).toBe('auth');
  });

  it('aborts after the timeout and reports it as a timeout', async () => {
    const ollama = new FakeOllama();
    ollama.force = 'timeout';
    const gen = createOllamaGenerator({ apiKey: 'k', model: 'm', timeoutMs: 30, fetch: ollama.fetch });
    const started = Date.now();
    const err = await gen(input('x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports an empty reply as empty text and a done_reason other than "stop" as cut', async () => {
    const ollama = new FakeOllama();
    const gen = createOllamaGenerator({ apiKey: 'k', model: 'm', fetch: ollama.fetch });
    ollama.force = 'empty';
    expect((await gen(input('x'))).text).toBe('');
    ollama.force = 'length';
    const r = await gen(input('x'));
    expect(r.cut).toBe(true);
    expect(r.text.endsWith('and the')).toBe(true);
  });
});

describe('provider chain fallback', () => {
  const ask = (c: ReturnType<typeof fullChain>, q: string) => c.model(input(q));

  it('answers from Ollama first and never calls Gemini when Ollama succeeds', async () => {
    const c = fullChain();
    const text = await ask(c, 'What does it eat?');
    expect(text).toBe('The Eurasian Blackbird eats seeds, according to the summary.');
    expect(c.ollama.calls).toHaveLength(1);
    expect(c.gemini.calls).toHaveLength(0);
    expect(c.lines.at(-1)).toMatch(/^\[ask\] provider=ollama model=fake-model fallback_from=- fallback_reason=- finish=stop prompt_tokens=1700 answer_tokens=110 total_tokens=1810 duration_ms=\d+$/);
    for (const l of c.lines) expect(l).not.toMatch(/What does it eat|seeds|test-key/);
  });

  it.each([
    ['rate_limit', 'rate_limit'],
    ['queue_full', 'queue_full'],
    ['server', 'server'],
    ['bad_gateway', 'server'],
    ['auth', 'auth'],
    ['network', 'network'],
    ['timeout', 'timeout'],
    ['empty', 'empty'],
    ['length', 'cut_off'],
  ])('falls back to Gemini on %s and logs fallback_from=ollama', async (scenario, reason) => {
    const c = fullChain({ OLLAMA_TIMEOUT_MS: '1000' });
    c.ollama.force = scenario as FakeOllama['force'];
    const text = await ask(c, 'What does it eat?');
    expect(text).toBe('The Eurasian Blackbird eats seeds, according to the summary.');
    expect(c.ollama.calls).toHaveLength(1);
    expect(c.gemini.calls).toHaveLength(1);
    expect(c.lines).toContain(`[ask] provider=ollama failed reason=${reason} (falling back)`);
    expect(c.lines.at(-1)).toMatch(new RegExp(`^\\[ask\\] provider=gemini model=gemini-test fallback_from=ollama fallback_reason=${reason} finish=stop prompt_tokens=1800 answer_tokens=120 total_tokens=2120 duration_ms=\\d+$`));
    for (const l of c.lines) expect(l).not.toMatch(/What does it eat|seeds|test-key/);
  });

  it('honours AI_PROVIDER_ORDER=gemini,ollama and falls back the other way', async () => {
    const c = fullChain({ AI_PROVIDER_ORDER: 'gemini,ollama' });
    c.ollama.answerOnly = true;
    const text = await ask(c, 'What does it eat? [scenario:throw]');
    expect(text).toBe('The Eurasian Blackbird eats seeds, according to the summary.');
    expect(c.gemini.calls).toHaveLength(1);
    expect(c.ollama.calls).toHaveLength(1);
    expect(c.lines.at(-1)).toMatch(/^\[ask\] provider=ollama model=fake-model fallback_from=gemini fallback_reason=(server|unknown) /);
  });

  it("the last provider's cut answer is kept and marked, as before", async () => {
    const c = fullChain();
    c.ollama.force = 'rate_limit';
    const text = await ask(c, 'where does it live? [scenario:truncated_twice]');
    expect(text).toBe(`The Wikipedia article does not mention Des Moines, though it notes that the species breeds across the northern forests. [Range] ${CUT_SHORT_SUFFIX}`);
    expect(c.gemini.calls).toHaveLength(2); // Gemini's own retry (#43)
    expect(c.lines.at(-1)).toMatch(/provider=gemini model=gemini-test fallback_from=ollama fallback_reason=rate_limit finish=cut/);
    const only = createChain([{ name: 'ollama', generate: createOllamaGenerator({ apiKey: 'k', model: 'm', fetch: c.ollama.fetch }) }], { log: () => undefined });
    c.ollama.force = 'length';
    expect(await only(input('x'))).toBe(`The Wikipedia article does not mention Des Moines, though it notes that the species breeds across the northern forests. [Range] ${CUT_SHORT_SUFFIX}`);
  });

  it('throws when every provider fails, with no request details in the error', async () => {
    const c = fullChain();
    c.ollama.force = 'server';
    const err = await ask(c, 'What does it eat? [scenario:throw]').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String(err)).not.toMatch(/What does it eat|503|fake/);
    expect(c.lines.at(-1)).toMatch(/^\[ask\] provider=gemini failed reason=\w+ \(no provider left\)$/);
    const empty = createChain([{ name: 'gemini', generate: async () => ({ text: '   ', cut: false, usage: {}, model: 'g', durationMs: 1 }) }], { log: () => undefined });
    await expect(empty(input('x'))).rejects.toBeInstanceOf(ProviderError);
    expect(() => createChain([])).toThrow();
  });

  it('records the answering provider and the fallback path', async () => {
    const recorded: Array<{ provider: string; fallbackFrom: string[] }> = [];
    const c = fullChain();
    const chain = createChain(
      [
        { name: 'ollama', generate: createOllamaGenerator({ apiKey: 'k', model: 'm', fetch: c.ollama.fetch }) },
        { name: 'gemini', generate: async () => ({ text: 'ok', cut: false, usage: { totalTokens: 5 }, model: 'g', durationMs: 1 }) },
      ] satisfies AnswerProvider[],
      { log: () => undefined, providerUsage: { record: (provider, fallbackFrom) => (recorded.push({ provider, fallbackFrom: [...fallbackFrom] }), { provider, requests: 1, promptTokens: 0, answerTokens: 0, fallbacks: 0 }), days: () => [], totals: () => [] } },
    );
    await chain(input('What does it eat?'));
    c.ollama.force = 'timeout';
    await chain(input('What does it eat?'));
    expect(recorded).toEqual([
      { provider: 'ollama', fallbackFrom: [] },
      { provider: 'gemini', fallbackFrom: ['ollama'] },
    ]);
  });

  it('members get a plain answer or the generic 502 through /v1/ask, never a provider error', async () => {
    const c = fullChain();
    c.ollama.force = 'auth'; // the fallback drill: a wrong Ollama key
    const t = await buildTestApp({ model: c.model, limits: { askPerMinute: 1000 } });
    const admin = await signUpAndLogin(t, ADMIN);
    const { token } = await approvedMember(t, admin, 'member@example.com');
    const ok = await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What does it eat?' }, bearer(token));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { answer: string }).answer).toBe('The Eurasian Blackbird eats seeds, according to the summary.');
    const both = await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What does it eat? [scenario:throw]' }, bearer(token));
    expect(both.status).toBe(502);
    expect(await both.json()).toEqual({ error: 'model_unavailable' });
  });
});
