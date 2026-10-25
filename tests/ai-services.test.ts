import { beforeEach, describe, expect, it } from 'vitest';
import { AI_SERVICES_KEY, describeAiServices, parseAiServices, refreshAiServices, resetAiServicesForTest, storedAiServices } from '../src/api/ai-services';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}
const asStorage = (m: MemStorage) => m as unknown as Storage;
const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

describe('AI service names from the server (DECISIONS.md #90)', () => {
  beforeEach(() => resetAiServicesForTest());

  it('describes the list in plain words', () => {
    expect(describeAiServices(null)).toBe('an AI service');
    expect(describeAiServices([])).toBe('an AI service');
    expect(describeAiServices(['Anthropic Claude'])).toBe('Anthropic Claude');
    expect(describeAiServices(['Ollama Cloud', 'Google Gemini'])).toBe('Ollama Cloud, or Google Gemini as backup');
    expect(describeAiServices(['A', 'B', 'C'])).toBe('A, with B then C as backups');
  });

  it('accepts only a short list of short names', () => {
    expect(parseAiServices({ services: ['Ollama Cloud'] })).toEqual(['Ollama Cloud']);
    expect(parseAiServices({ services: [''] })).toBeNull();
    expect(parseAiServices({ services: ['x'.repeat(41)] })).toBeNull();
    expect(parseAiServices({ services: [1] })).toBeNull();
    expect(parseAiServices({ services: Array(6).fill('A') })).toBeNull();
    expect(parseAiServices(null)).toBeNull();
  });

  it('stores the server answer, asks once per page load, and keeps the stored list when the server cannot be reached', async () => {
    const mem = new MemStorage();
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls++;
      expect(url).toBe('https://api.example/v1/ai-services');
      return new Response(JSON.stringify({ services: ['Ollama Cloud', 'Google Gemini'] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await refreshAiServices(fetchFn, asStorage(mem), 'https://api.example')).toEqual(['Ollama Cloud', 'Google Gemini']);
    expect(await refreshAiServices(fetchFn, asStorage(mem), 'https://api.example')).toEqual(['Ollama Cloud', 'Google Gemini']);
    expect(calls).toBe(1);
    expect(JSON.parse(mem.getItem(AI_SERVICES_KEY)!)).toEqual({ services: ['Ollama Cloud', 'Google Gemini'] });

    resetAiServicesForTest();
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect(await refreshAiServices(offline, asStorage(mem))).toEqual(['Ollama Cloud', 'Google Gemini']);
    // A failure lets the next page ask again.
    expect(await refreshAiServices(ok({ services: ['Anthropic Claude'] }), asStorage(mem))).toEqual(['Anthropic Claude']);
    expect(storedAiServices(asStorage(mem))).toEqual(['Anthropic Claude']);
  });

  it('ignores a malformed answer and an error status', async () => {
    const mem = new MemStorage();
    expect(await refreshAiServices(ok({ services: 'Gemini' }), asStorage(mem))).toBeNull();
    expect(await refreshAiServices((async () => new Response('{}', { status: 502 })) as typeof fetch, asStorage(mem))).toBeNull();
    expect(mem.getItem(AI_SERVICES_KEY)).toBeNull();
  });
});
