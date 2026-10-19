import { describe, expect, it } from 'vitest';
import { createAskCostStore, utcMonth } from '../src/ask-cost.js';
import { openDatabase } from '../src/db.js';
import { CAP_ALERT_LEVELS, capAlertMail, capMicrosOf, createGeminiCapGuard } from '../src/gemini-cap.js';
import { cappedCostMicros, maxKnownPrice, PRICES, priceForModel } from '../src/pricing.js';
import { createChain, createProviderChain, type AnswerProvider } from '../src/providers/index.js';
import { ProviderError } from '../src/providers/ollama.js';
import { FakeGemini } from './fake-gemini.js';
import { FakeMailer } from '../src/mailer.js';
import { testConfig } from './helpers.js';

const usage = (promptTokens: number, answerTokens: number) => ({ promptTokens, answerTokens, thinkingTokens: 0, cachedTokens: 0 });
const input = { systemInstruction: 's', prompt: 'p' };

describe('pricing for the cap', () => {
  it('an unknown model is billed at the most expensive known price', () => {
    const max = maxKnownPrice();
    expect(max).toEqual(PRICES['gemini-3.8-flash']);
    expect(priceForModel('gemini-9.9-ultra-preview')).toEqual(max);
    expect(cappedCostMicros('gemini-9.9-ultra-preview', usage(1_000_000, 1_000_000))).toBe(Math.round((max.inputPerM + max.outputPerM) * 1_000_000));
  });
  it('a known model keeps its own price; .env overrides replace the input and/or output rate', () => {
    expect(priceForModel('gemini-3.5-flash-lite')).toEqual(PRICES['gemini-3.5-flash-lite']);
    const o = priceForModel('gemini-3.5-flash-lite', { inputPerM: 1, outputPerM: 10 });
    expect(o.inputPerM).toBe(1);
    expect(o.outputPerM).toBe(10);
    expect(o.cachedInputPerM).toBeLessThanOrEqual(1);
    expect(cappedCostMicros('whatever', usage(1_000_000, 0), { inputPerM: 2 })).toBe(2_000_000);
    const store = createAskCostStore(openDatabase(':memory:'), { priceOverrides: { outputPerM: 100 } });
    expect(store.record('gemini-3.5-flash-lite', usage(0, 1_000_000))).toBe(100_000_000);
  });
});

describe('monthly spend and alerts', () => {
  it('sums the UTC calendar month only; a new month starts from zero', () => {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const sep30 = new Date('2026-09-30T23:59:59Z');
    const oct1 = new Date('2026-10-01T00:00:01Z');
    const oct19 = new Date('2026-10-19T12:00:00Z');
    costs.record('gemini-3.8-flash', usage(1_000_000, 0), sep30); // 750_000 micro-dollars in September
    costs.record('gemini-3.8-flash', usage(1_000_000, 0), oct1); // 750_000 in October
    costs.record('gemini-3.8-flash', usage(0, 100_000), oct19); // 375_000 in October
    expect(costs.monthSpendMicros(sep30)).toBe(750_000);
    expect(costs.monthSpendMicros(oct19)).toBe(1_125_000);
    expect(costs.monthSpendMicros(new Date('2026-11-01T00:00:00Z'))).toBe(0); // rollover resets
    expect(utcMonth(oct19)).toBe('2026-10');
    const st = costs.monthStatus(capMicrosOf(2), oct19);
    expect(st).toEqual({ month: '2026-10', spentMicros: 1_125_000, capMicros: 2_000_000, percent: 56, alertsSent: [] });
  });
  it('an alert level is marked once per month, and again in the next month', () => {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const oct = new Date('2026-10-19T12:00:00Z');
    expect(costs.markAlert(50, oct)).toBe(true);
    expect(costs.markAlert(50, oct)).toBe(false);
    expect(costs.markAlert(100, oct)).toBe(true);
    expect(costs.monthStatus(capMicrosOf(2), oct).alertsSent).toEqual([50, 100]);
    expect(costs.markAlert(50, new Date('2026-11-02T00:00:00Z'))).toBe(true);
  });
});

describe('the cap guard', () => {
  /** Spend is seeded in output tokens at gemini-3.8-flash's $3.75/M, so amounts are exact: 100_000 tokens = $0.375. */
  function setup(capUsd: number, spentTokens: number) {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const now = new Date('2026-10-19T12:00:00Z');
    if (spentTokens > 0) costs.record('gemini-3.8-flash', usage(0, spentTokens), now);
    let calls = 0;
    const alerts: number[] = [];
    const lines: string[] = [];
    const generate = createGeminiCapGuard(
      async () => {
        calls++;
        // a real call records its own cost through the store, like createGeminiGenerator does
        costs.record('gemini-3.8-flash', usage(0, 100_000), now); // $0.375 per call
        return { text: 'ok', cut: false, usage: {}, model: 'gemini-3.8-flash', durationMs: 1 };
      },
      { costs, capUsd, sendAlert: async (level) => void alerts.push(level), log: (l) => lines.push(l), now: () => now },
    );
    return { costs, generate, get calls() { return calls; }, alerts, lines, now };
  }

  it('at or over the cap Gemini is not called and the failure kind is "cap"', async () => {
    const t = setup(2, 600_000); // $2.25 >= $2.00
    await expect(t.generate(input)).rejects.toMatchObject({ name: 'ProviderError', kind: 'cap' });
    expect(t.calls).toBe(0);
    expect(t.lines.some((l) => l.includes('[cap] gemini skipped'))).toBe(true);
  });
  it('a cap of 0 disables Gemini entirely', async () => {
    const t = setup(0, 0);
    await expect(t.generate(input)).rejects.toBeInstanceOf(ProviderError);
    expect(t.calls).toBe(0);
  });
  it('under the cap the call goes through and is counted; the 50 % and 100 % alerts each go out once', async () => {
    const t = setup(2, 140_000); // $0.525 of $2.00
    await t.generate(input); // $0.90 -> 45 %
    expect(t.alerts).toEqual([]);
    await t.generate(input); // $1.275 -> 63 %: 50 % alert
    expect(t.alerts).toEqual([50]);
    await t.generate(input); // $1.65 -> 82 %: nothing new
    expect(t.alerts).toEqual([50]);
    await t.generate(input); // $2.025 -> 101 %: the 100 % alert
    expect(t.alerts).toEqual([50, 100]);
    await expect(t.generate(input)).rejects.toMatchObject({ kind: 'cap' }); // and now it is skipped
    expect(t.calls).toBe(4);
    expect(t.costs.monthStatus(capMicrosOf(2), t.now).alertsSent).toEqual([50, 100]);
  });
  it('a failing alert mail is logged and never fails the member request', async () => {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const now = new Date('2026-10-19T12:00:00Z');
    const lines: string[] = [];
    const generate = createGeminiCapGuard(
      async () => {
        costs.record('gemini-3.8-flash', usage(0, 400_000), now); // $1.50 -> 75 %
        return { text: 'ok', cut: false, usage: {}, model: 'gemini-3.8-flash', durationMs: 1 };
      },
      { costs, capUsd: 2, sendAlert: async () => { throw new Error('smtp down'); }, log: (l) => lines.push(l), now: () => now },
    );
    await expect(generate(input)).resolves.toMatchObject({ text: 'ok' });
    expect(lines.some((l) => l.includes('alert mail failed'))).toBe(true);
    expect(costs.monthStatus(capMicrosOf(2), now).alertsSent).toEqual([50]); // marked, so it is not retried every call
  });
  it('the alert mails name the month, the amounts and what happens next, never a question', () => {
    const m50 = capAlertMail(50, { month: '2026-10', spentMicros: 1_000_000, capMicros: 2_000_000 });
    expect(m50.subject).toBe('Gemini spend at 50% for 2026-10: $1.00 of $2.00');
    const m100 = capAlertMail(100, { month: '2026-10', spentMicros: 2_100_000, capMicros: 2_000_000 });
    expect(m100.subject).toContain('cap reached');
    expect(m100.body).toContain('Bird questions are busy right now');
    expect(CAP_ALERT_LEVELS).toEqual([50, 100]);
  });
});

describe('the chain under the cap', () => {
  it('cap reached: Gemini is skipped, Ollama answers; with Ollama down too, the chain throws (members get the 502 "busy" answer)', async () => {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const now = new Date('2026-10-19T12:00:00Z');
    costs.record('gemini-3.8-flash', usage(0, 600_000), now); // $2.25 >= $2 cap
    const gemini = new FakeGemini();
    const lines: string[] = [];
    const mailer = new FakeMailer();
    const chain = createProviderChain(testConfig({ OLLAMA_API_KEY: 'o', GEMINI_API_KEY: 'g', AI_PROVIDER_ORDER: 'gemini,ollama', GEMINI_MONTHLY_CAP_USD: '2' }), {
      geminiClient: gemini,
      costs,
      mailer,
      adminEmail: 'admin@example.com',
      now: () => now,
      log: (l) => lines.push(l),
      // Ollama "down": every fetch fails
      fetch: async () => { throw new Error('fetch failed'); },
    });
    expect(chain).not.toBeNull();
    await expect(chain!(input)).rejects.toBeInstanceOf(ProviderError);
    expect(gemini.calls).toHaveLength(0); // never called at the cap
    expect(lines.some((l) => l.includes('provider=gemini failed reason=cap'))).toBe(true);
    expect(mailer.sent).toEqual([]); // no mail without a successful Gemini call (already over the cap before this request)
  });
  it('under the cap Gemini still answers and the alert mail goes to the admin once', async () => {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const now = new Date('2026-10-19T12:00:00Z');
    const mailer = new FakeMailer();
    const provider: AnswerProvider = {
      name: 'gemini',
      generate: createGeminiCapGuard(
        async () => {
          costs.record('gemini-3.8-flash', usage(0, 300_000), now); // $1.125 per call
          return { text: 'answer', cut: false, usage: { promptTokens: 1, answerTokens: 1 }, model: 'gemini-3.8-flash', durationMs: 1 };
        },
        { costs, capUsd: 2, log: () => undefined, now: () => now, sendAlert: async (level) => { await mailer.send({ to: 'admin@example.com', subject: `${level}`, text: 'x' }); } },
      ),
    };
    const chain = createChain([provider], { log: () => undefined });
    expect(await chain(input)).toBe('answer'); // 56 %: 50 % alert
    expect(await chain(input)).toBe('answer'); // 112 %: 100 % alert
    expect(mailer.sent.map((m) => m.subject)).toEqual(['50', '100']);
    await expect(chain(input)).rejects.toBeInstanceOf(ProviderError);
    expect(mailer.sent).toHaveLength(2);
  });
});
