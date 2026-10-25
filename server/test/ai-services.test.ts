import { describe, expect, it } from 'vitest';
import { aiServiceLabels, PROVIDER_LABELS } from '../src/providers/index.js';
import { buildTestApp, ORIGIN, testConfig } from './helpers.js';

describe('GET /v1/ai-services: which AI services a question can go to', () => {
  it('lists the configured services in the order they are tried, without a sign-in, with CORS', async () => {
    const t = await buildTestApp({ env: { OLLAMA_API_KEY: 'o', GEMINI_API_KEY: 'g', AI_PROVIDER_ORDER: 'ollama,gemini' } });
    const res = await t.app.request('/v1/ai-services', { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ services: ['Ollama Cloud', 'Google Gemini'] });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('follows AI_PROVIDER_ORDER and leaves out a provider without its key', () => {
    expect(aiServiceLabels(testConfig({ OLLAMA_API_KEY: 'o', GEMINI_API_KEY: 'g', AI_PROVIDER_ORDER: 'gemini,ollama' }))).toEqual(['Google Gemini', 'Ollama Cloud']);
    expect(aiServiceLabels(testConfig({ GEMINI_API_KEY: 'g', AI_PROVIDER_ORDER: 'ollama,gemini' }))).toEqual(['Google Gemini']);
    expect(aiServiceLabels(testConfig({}))).toEqual([]);
  });

  it('names companies and services, never a model', () => {
    for (const label of Object.values(PROVIDER_LABELS)) expect(label).not.toMatch(/\d|flash|\bpro\b|gpt|qwen|gemma|sonnet|opus|haiku/i);
  });
});
