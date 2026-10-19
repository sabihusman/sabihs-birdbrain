import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ThinkingLevel } from '@google/genai';
import { answerQuestion, createGeminiModel, SYSTEM_INSTRUCTION } from '../src/ask.js';
import { CACHE_HIT_LOG_LINE, createAskCostStore } from '../src/ask-cost.js';
import { ANSWER_CACHE_TTL_MS, answerCacheKey, createAnswerCache, normalizeQuestion } from '../src/answer-cache.js';
import { CONTEXT_TOKEN_BUDGET, estimateTokens, keywords, scoreSection, selectRelevantSections, stem } from '../src/context-select.js';
import { createUsageStore, openDatabase } from '../src/db.js';
import { DEFAULT_ASSUMPTIONS, EVAL_MODELS, EVAL_QUESTIONS, formatPlan, formatResults, planRun, runEval, UsageCollector } from '../src/eval-models.js';
import { costMicros, FLASH_LITE_MODEL, formatUsd, PRICES, thinkingLevelFor, usageFromMetadata } from '../src/pricing.js';
import { articleFromExtract, type ArticleSection } from '../src/wiki-article.js';
import { FakeGemini } from './fake-gemini.js';
import { ADMIN, approvedMember, buildTestApp, get, LABELS, post, signUpAndLogin, bearer } from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/wiki-extract-blackbird.json', import.meta.url), 'utf8')) as { query: { pages: Array<{ title: string; extract: string }> } };
const page = fixture.query.pages[0];
const article = () => articleFromExtract(page.title, page.extract, 1)!;

describe('pricing', () => {
  it('prices the two models from the pricing page and bills thinking at the output rate', () => {
    expect(PRICES['gemini-3.8-flash']).toMatchObject({ inputPerM: 0.75, outputPerM: 3.75, cachedInputPerM: 0.075 });
    expect(PRICES[FLASH_LITE_MODEL]).toMatchObject({ inputPerM: 0.3, outputPerM: 2.5, cachedInputPerM: 0.03 });
    // 1,000 prompt + 100 answer + 200 thinking tokens on 3.8 Flash: 0.75 + 0.375 + 0.75 = 1.875 milli-dollars
    expect(costMicros('gemini-3.8-flash', { promptTokens: 1000, answerTokens: 100, thinkingTokens: 200, cachedTokens: 0 })).toBe(1875);
    // cached prompt tokens are billed at the cached rate
    expect(costMicros('gemini-3.8-flash', { promptTokens: 1000, answerTokens: 0, thinkingTokens: 0, cachedTokens: 1000 })).toBe(75);
    expect(costMicros('gemini-3.8-flash', { promptTokens: 100, answerTokens: 0, thinkingTokens: 0, cachedTokens: 500 })).toBe(8);
    expect(costMicros('gemini-x', { promptTokens: 1, answerTokens: 1, thinkingTokens: 1, cachedTokens: 0 })).toBeNull();
    expect(formatUsd(1875)).toBe('0.001875');
    expect(formatUsd(null)).toBe('unknown');
  });

  it('chooses the lowest thinking level each model accepts', () => {
    expect(thinkingLevelFor('gemini-3.8-flash')).toBe(ThinkingLevel.LOW);
    expect(thinkingLevelFor(FLASH_LITE_MODEL)).toBe(ThinkingLevel.MINIMAL);
    expect(thinkingLevelFor('gemini-unknown')).toBe(ThinkingLevel.LOW);
  });

  it('reads token counts from usageMetadata, missing counts as zero', () => {
    expect(usageFromMetadata(undefined)).toEqual({ promptTokens: 0, answerTokens: 0, thinkingTokens: 0, cachedTokens: 0 });
    expect(usageFromMetadata({ promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1, cachedContentTokenCount: 4 })).toEqual({ promptTokens: 5, answerTokens: 2, thinkingTokens: 1, cachedTokens: 4 });
  });

  it('createGeminiModel sends MINIMAL thinking to Flash-Lite and LOW to 3.8 Flash, never thinkingBudget, and logs the cost', async () => {
    for (const [model, level, cost] of [
      ['gemini-3.8-flash', ThinkingLevel.LOW, 0.0018 /* 1800×0.75 + 320×3.75 = 2550 µ$ */],
      [FLASH_LITE_MODEL, ThinkingLevel.MINIMAL, 0.0013],
    ] as const) {
      const gemini = new FakeGemini();
      const lines: string[] = [];
      const m = createGeminiModel('fake-key', model, gemini, (l) => lines.push(l));
      await m({ systemInstruction: SYSTEM_INSTRUCTION, prompt: '<source>[Section: Diet]\nSeeds.</source>\nQUESTION: what does it eat?' });
      expect(gemini.last.config?.thinkingConfig).toEqual({ thinkingLevel: level });
      expect(gemini.last.config?.thinkingConfig?.thinkingBudget).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/ cost_usd=0\.\d{6} cached=false$/);
      expect(Number(/cost_usd=([\d.]+)/.exec(lines[0])![1])).toBeGreaterThan(cost);
      expect(lines[0]).not.toMatch(/what does it eat|Seeds/);
    }
  });
});

describe('ask_cost daily totals', () => {
  it('sums tokens and cost per UTC day, counts cache hits and unpriced calls, and lists the last 30 days newest first', () => {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const d1 = new Date('2026-10-01T23:59:00Z');
    const d2 = new Date('2026-10-02T00:01:00Z');
    expect(costs.record('gemini-3.8-flash', { promptTokens: 1000, answerTokens: 100, thinkingTokens: 200, cachedTokens: 0 }, d1)).toBe(1875);
    expect(costs.record('gemini-3.8-flash', { promptTokens: 1000, answerTokens: 100, thinkingTokens: 200, cachedTokens: 0 }, d1)).toBe(1875);
    expect(costs.record('nope', { promptTokens: 10, answerTokens: 1, thinkingTokens: 0, cachedTokens: 0 }, d2)).toBeNull();
    costs.recordCacheHit(d2);
    costs.recordCacheHit(d2);
    const days = costs.summary(30, d2);
    expect(days).toEqual([
      { day: '2026-10-02', requests: 1, promptTokens: 10, answerTokens: 1, thinkingTokens: 0, cachedTokens: 0, costMicros: 0, unpricedRequests: 1, cacheHits: 2 },
      { day: '2026-10-01', requests: 2, promptTokens: 2000, answerTokens: 200, thinkingTokens: 400, cachedTokens: 0, costMicros: 3750, unpricedRequests: 0, cacheHits: 0 },
    ]);
    // a day outside the window drops out
    expect(costs.summary(1, d2).map((d) => d.day)).toEqual(['2026-10-02']);
    expect(costs.summary(30, new Date('2026-11-15T00:00:00Z'))).toEqual([]);
  });

  it('the model records each billed call through the shared store, retries included', async () => {
    const costs = createAskCostStore(openDatabase(':memory:'));
    const gemini = new FakeGemini();
    const m = createGeminiModel('fake-key', 'gemini-3.8-flash', gemini, () => undefined, costs);
    await m({ systemInstruction: SYSTEM_INSTRUCTION, prompt: '<source>[Section: Range]\nNorth.</source>\nQUESTION: where? [scenario:truncated_once]' });
    const [today] = costs.summary();
    expect(today.requests).toBe(2);
    expect(today.promptTokens).toBe(3600);
    expect(today.costMicros).toBeGreaterThan(0);
  });
});

describe('answer cache', () => {
  it('normalises questions (case, whitespace, punctuation, length) into a region-independent key', () => {
    expect(normalizeQuestion('  What does it EAT?!  ')).toBe('what does it eat');
    expect(normalizeQuestion('what\n does   it eat')).toBe('what does it eat');
    expect(normalizeQuestion('x'.repeat(300))).toHaveLength(200);
    expect(answerCacheKey('Turdus merula', 'What does it eat?')).toBe(answerCacheKey('turdus merula ', 'what does it eat'));
    expect(answerCacheKey('Turdus merula', 'What does it eat?')).not.toBe(answerCacheKey('Parus major', 'What does it eat?'));
    expect(answerCacheKey('Turdus merula', 'What does it eat?')).not.toContain('eat');
  });

  it('returns a stored answer for 7 days and nothing after, with a fake clock', () => {
    const cache = createAnswerCache(openDatabase(':memory:'));
    const t0 = new Date('2026-10-19T12:00:00Z');
    const body = { answer: 'Seeds. [Diet]', source: { title: 'T', url: 'u' }, citations: [{ section: 'Diet', url: 'u#Diet' }], context: 'article' as const };
    expect(cache.get('Turdus merula', 'What does it eat?', t0)).toBeNull();
    cache.put('Turdus merula', 'What does it eat?', body, t0);
    expect(cache.get('Turdus merula', 'what does it eat', new Date(t0.getTime() + ANSWER_CACHE_TTL_MS - 1))).toEqual(body);
    expect(cache.get('Turdus merula', 'what does it eat', new Date(t0.getTime() + ANSWER_CACHE_TTL_MS))).toBeNull();
    // a later put prunes expired rows
    cache.put('Parus major', 'How big?', body, new Date(t0.getTime() + ANSWER_CACHE_TTL_MS + 1));
    expect(cache.get('Turdus merula', 'what does it eat', t0)).toBeNull();
  });

  it('answerQuestion serves a repeat question from the cache without a model call, without counting the caps, and caches only successes', async () => {
    const db = openDatabase(':memory:');
    const usage = createUsageStore(db);
    const costs = createAskCostStore(db);
    const answers = createAnswerCache(db);
    const lines: string[] = [];
    let calls = 0;
    let reply = 'It eats seeds and worms. [Behaviour and ecology]';
    const deps = { labels: LABELS, wiki: async () => null, article: async () => article(), model: async () => (calls++, reply), usage, caps: { perUserDaily: 1, globalDaily: 5 }, maxQuestionChars: 500, answers, costs, log: (l: string) => lines.push(l) };
    const now = new Date('2026-10-19T12:00:00Z');
    const user = { id: 'u1', status: 'approved' };
    const first = await answerQuestion(deps, user, { species: 'Turdus merula', question: 'What does it eat?' }, now);
    expect(first.status).toBe(200);
    expect(calls).toBe(1);
    // the user is now at their cap of 1, but the cached repeat still answers
    const again = await answerQuestion(deps, user, { species: 'Turdus merula', question: 'what does it EAT' }, now);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, cached: true });
    expect(calls).toBe(1);
    expect(usage.get('user:u1', now)).toBe(1);
    expect(lines).toEqual([CACHE_HIT_LOG_LINE]);
    expect(costs.summary(30, now)[0].cacheHits).toBe(1);
    // another member hits the same cache; another species or question does not
    const other = await answerQuestion(deps, { id: 'u2', status: 'approved' }, { species: 'Turdus merula', question: 'What does it eat?' }, now);
    expect(other.body).toHaveProperty('cached', true);
    const fresh = await answerQuestion(deps, { id: 'u2', status: 'approved' }, { species: 'Turdus merula', question: 'Where does it nest?' }, now);
    expect(fresh.body).not.toHaveProperty('cached');
    expect(calls).toBe(2);
    // a failed answer is not cached
    reply = '';
    const bad = await answerQuestion(deps, { id: 'u3', status: 'approved' }, { species: 'Parus major', question: 'How big?' }, now);
    expect(bad.status).toBe(502);
    reply = 'About 14 cm. [Description]';
    const retry = await answerQuestion(deps, { id: 'u4', status: 'approved' }, { species: 'Parus major', question: 'How big?' }, now);
    expect(retry.status).toBe(200);
    expect(retry.body).not.toHaveProperty('cached');
    // after the TTL the model is asked again
    const later = await answerQuestion(deps, { id: 'u5', status: 'approved' }, { species: 'Turdus merula', question: 'What does it eat?' }, new Date(now.getTime() + ANSWER_CACHE_TTL_MS + 1));
    expect(later.body).not.toHaveProperty('cached');
  });
});

describe('context selection', () => {
  const sections = article().sections;

  it('extracts keyword stems without stop words', () => {
    expect([...keywords('What does the bird eat in winter?')]).toEqual(['eat', 'winter']);
    expect(keywords('tell me about it').size).toBe(0);
    expect([...keywords('It eats berries while breeding and nested')]).toEqual(['eat', 'berry', 'breed', 'nest']);
    expect(stem('grass')).toBe('grass');
    expect(stem('eggs')).toBe('egg');
    expect(stem('finches')).toBe('finch');
    expect(stem('breed')).toBe('breed');
    expect(stem('spring')).toBe('spring');
  });

  it('scores heading matches higher than body matches', () => {
    const q = keywords('What is its diet?');
    expect(scoreSection({ heading: 'Diet', text: 'Nothing relevant.' }, q)).toBe(3);
    expect(scoreSection({ heading: 'Habitat', text: 'Its diet is seeds.' }, q)).toBe(1);
    expect(scoreSection({ heading: 'Diet', text: 'diet diet diet' }, q)).toBe(4);
    // the lead is always a candidate, ranked below any real match
    expect(scoreSection({ heading: 'Lead', text: 'Nothing relevant.' }, q)).toBe(1);
    expect(scoreSection({ heading: 'Lead', text: 'Its diet is seeds.' }, q)).toBe(2);
  });

  it('sends only the sections the question matches, in article order, and keeps the fence defence', () => {
    const chosen = selectRelevantSections(sections, 'Where does it breed and what does it eat?');
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length).toBeLessThan(sections.length);
    expect(chosen.every((s) => sections.includes(s))).toBe(true);
    const order = chosen.map((s) => sections.indexOf(s));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(chosen.map((s) => s.heading)).toEqual(['Lead', 'Behaviour and ecology']);
  });

  it('falls back to the lead when nothing matches, and to the first section without a lead', () => {
    expect(selectRelevantSections(sections, 'Tell me about it').map((s) => s.heading)).toEqual(['Lead']);
    const noLead = sections.filter((s) => s.heading !== 'Lead');
    expect(selectRelevantSections(noLead, 'zzzz qqqq').map((s) => s.heading)).toEqual(['Description']);
    expect(selectRelevantSections([{ heading: 'Status', url: 'u', text: 'x' }], 'zzzz').map((s) => s.heading)).toEqual(['Status']);
    expect(selectRelevantSections([], 'anything')).toEqual([]);
  });

  it('stays within the token budget, cutting the last section at a word boundary', () => {
    const long: ArticleSection[] = ['Description', 'Diet', 'Habitat', 'Breeding'].map((heading) => ({ heading, url: 'u', text: `${heading.toLowerCase()} word `.repeat(600) }));
    const chosen = selectRelevantSections(long, 'diet habitat breeding description');
    const total = chosen.reduce((n, s) => n + estimateTokens(s.heading) + estimateTokens(s.text) + 4, 0);
    expect(total).toBeLessThanOrEqual(CONTEXT_TOKEN_BUDGET + 2);
    expect(chosen.length).toBeLessThan(long.length);
    const cutOne = chosen.find((s) => s.text.endsWith('[…]'));
    expect(cutOne).toBeDefined();
    expect(cutOne!.text).not.toMatch(/\S\[…\]$/);
    expect(selectRelevantSections(long, 'diet', 100)[0].text.length).toBeLessThanOrEqual(420);
  });

  it('the pipeline sends the selected sections only and cites from them', async () => {
    const prompts: string[] = [];
    const deps = { labels: LABELS, wiki: async () => null, article: async () => article(), model: async (i: { prompt: string }) => (prompts.push(i.prompt), 'It breeds in spring. [Behaviour and ecology]'), usage: createUsageStore(openDatabase(':memory:')), caps: { perUserDaily: 5, globalDaily: 5 }, maxQuestionChars: 500 };
    const out = await answerQuestion(deps, { id: 'u', status: 'approved' }, { species: 'Turdus merula', question: 'When does it breed?' });
    expect(out.status).toBe(200);
    expect(prompts[0]).toContain('[Section: Behaviour and ecology]');
    expect(prompts[0]).not.toContain('[Section: Taxonomy and systematics]');
    expect(prompts[0].indexOf('<source>')).toBeLessThan(prompts[0].indexOf('QUESTION:'));
    if (out.status === 200) expect(out.body.citations.map((c) => c.section)).toEqual(['Behaviour and ecology']);
  });
});

describe('admin ask-costs endpoint', () => {
  it('is admin-only and reports the days with the configured model', async () => {
    const t = await buildTestApp();
    const admin = await signUpAndLogin(t, ADMIN);
    const member = await approvedMember(t, admin, 'm@example.com');
    expect((await get(t.app, '/v1/admin/ask-costs')).status).toBe(403);
    expect((await get(t.app, '/v1/admin/ask-costs', bearer(member.token))).status).toBe(403);
    const empty = (await (await get(t.app, '/v1/admin/ask-costs', bearer(admin))).json()) as { model: string; days: unknown[] };
    expect(empty).toEqual({ model: 'gemini-3.8-flash', days: [] });
    // one question, then the same again: the second is a cache hit
    expect((await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'What does it eat?' }, bearer(member.token))).status).toBe(200);
    const second = (await (await post(t.app, '/v1/ask', { species: 'Turdus merula', question: 'what does it eat' }, bearer(member.token))).json()) as { cached?: boolean };
    expect(second.cached).toBe(true);
    expect(t.modelCalls).toHaveLength(1);
    const res = (await (await get(t.app, '/v1/admin/ask-costs', bearer(admin))).json()) as { days: Array<{ cacheHits: number; requests: number }> };
    // the test model is a plain function, so no billed call is recorded, only the cache hit
    expect(res.days).toHaveLength(1);
    expect(res.days[0].cacheHits).toBe(1);
    expect(JSON.stringify(res)).not.toMatch(/eat/);
  });
});

describe('eval-models', () => {
  it('has 20 questions across 5 known species and two priced models', () => {
    expect(EVAL_QUESTIONS).toHaveLength(20);
    expect(new Set(EVAL_QUESTIONS.map((q) => q.species)).size).toBe(5);
    expect(EVAL_MODELS).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    for (const m of EVAL_MODELS) expect(PRICES[m]).toBeDefined();
  });

  it('plans the cost before any call and refuses above the budget or for an unpriced model', () => {
    const plan = planRun(EVAL_MODELS, EVAL_QUESTIONS);
    expect(plan.models.map((m) => m.calls)).toEqual([20, 20]);
    expect(plan.models[0].usage.promptTokens).toBe(DEFAULT_ASSUMPTIONS.promptTokens * 20);
    expect(plan.totalMicros).not.toBeNull();
    expect(plan.totalMicros!).toBeLessThan(100_000);
    expect(plan.withinBudget).toBe(true);
    expect(formatPlan(plan)).toMatch(/within budget/);
    expect(planRun(EVAL_MODELS, EVAL_QUESTIONS, undefined, 0.001).withinBudget).toBe(false);
    const unknown = planRun(['gemini-nope'], EVAL_QUESTIONS);
    expect(unknown.totalMicros).toBeNull();
    expect(unknown.withinBudget).toBe(false);
    expect(formatPlan(unknown)).toMatch(/unknown price/);
  });

  it('runs the pipeline against the fake client for both models with one article fetch per species and formats the table', async () => {
    let fetches = 0;
    const models = EVAL_MODELS.map((model) => {
      const collector = new UsageCollector();
      return { model, collector, answer: createGeminiModel('fake-key', model, new FakeGemini(), () => undefined, collector) };
    });
    const questions = EVAL_QUESTIONS.filter((q) => q.species === 'Turdus merula' || q.species === 'Parus major').slice(0, 5);
    const rows = await runEval({ labels: LABELS, article: async () => (fetches++, article()), models }, questions);
    expect(fetches).toBe(2);
    expect(rows).toHaveLength(5);
    expect(rows[0].answers.map((a) => a.model)).toEqual(EVAL_MODELS);
    expect(rows[0].answers[0].usage.promptTokens).toBe(1800);
    expect(rows[0].answers[0].costMicros).toBe(1800 * 0.75 + 320 * 3.75);
    const table = formatResults(rows, EVAL_MODELS);
    expect(table).toContain('| Turdus merula | What does it eat? |');
    expect(table).toContain('| gemini-3.8-flash | 5 | 9000 | 600 | 1000 | 0 | 0.012750 |');
    expect(table).toContain('| gemini-3.5-flash-lite | 5 | 9000 | 600 | 1000 | 0 | 0.006700 |');
  });
});
