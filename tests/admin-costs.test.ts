import { describe, expect, it } from 'vitest';
import { ApiClient, type AskCostDay } from '../src/api/client';
import { fmtUsd, providerRows, sumCostDays } from '../src/ui/views/admin';
import { MemoryStorage } from './helpers/memory-storage';

const day = (over: Partial<AskCostDay>): AskCostDay => ({ day: '2026-10-19', requests: 0, promptTokens: 0, answerTokens: 0, thinkingTokens: 0, cachedTokens: 0, costMicros: 0, unpricedRequests: 0, cacheHits: 0, ...over });

describe('admin ask costs', () => {
  it('sums the days and formats micro-dollars', () => {
    const t = sumCostDays([day({ requests: 2, promptTokens: 3000, answerTokens: 200, thinkingTokens: 100, costMicros: 4000, cacheHits: 1 }), day({ day: '2026-10-18', requests: 1, promptTokens: 1500, costMicros: 1500, unpricedRequests: 1 })]);
    expect(t).toMatchObject({ requests: 3, promptTokens: 4500, answerTokens: 200, thinkingTokens: 100, costMicros: 5500, unpricedRequests: 1, cacheHits: 1 });
    expect(fmtUsd(5500)).toBe('$0.0055');
    expect(fmtUsd(0)).toBe('$0.0000');
  });

  it('lists providers in configured order with zero rows for the unused one', () => {
    const rows = providerRows({ providerOrder: ['ollama', 'gemini'], models: { ollama: 'gemma4:31b', gemini: 'gemini-3.5-flash-lite' }, providers: [{ provider: 'gemini', requests: 2, promptTokens: 3000, answerTokens: 200, fallbacks: 2 }] });
    expect(rows).toEqual([
      { provider: 'ollama', model: 'gemma4:31b', requests: 0, fallbacks: 0, promptTokens: 0, answerTokens: 0 },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite', requests: 2, fallbacks: 2, promptTokens: 3000, answerTokens: 200 },
    ]);
    expect(providerRows({})).toEqual([]);
    expect(providerRows({ providers: [{ provider: 'ollama', requests: 1, promptTokens: 1, answerTokens: 1, fallbacks: 0 }] })[0]).toMatchObject({ provider: 'ollama', model: '?' });
  });

  it('the client reads GET /v1/admin/ask-costs with the bearer token', async () => {
    const storage = new MemoryStorage();
    const urls: string[] = [];
    const api = new ApiClient('https://api.test', storage, async (input, init) => {
      urls.push(`${init?.method} ${String(input)}`);
      return new Response(JSON.stringify({ model: 'gemini-3.8-flash', days: [day({ requests: 1 })] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await api.adminAskCosts();
    expect(urls).toEqual(['GET https://api.test/v1/admin/ask-costs']);
    expect(res.model).toBe('gemini-3.8-flash');
    expect(res.days[0].requests).toBe(1);
  });
});
