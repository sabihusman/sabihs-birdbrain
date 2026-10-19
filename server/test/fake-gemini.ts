import type { GenerateContentParameters } from '@google/genai';
import { readFileSync } from 'node:fs';
import type { GenAiClient, GenAiResponse } from '../src/ask.js';

export type Scenario = 'answer' | 'refusal' | 'leak_verbatim' | 'leak_paraphrased' | 'followed_injection' | 'markup' | 'too_long' | 'throw' | 'empty' | 'truncated_once' | 'truncated_twice';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/gemini-responses.json', import.meta.url), 'utf8')) as Record<string, string>;

/** Which recorded reply a prompt gets: chosen from the QUESTION line, as a real model would react to it. */
export function pickScenario(prompt: string): Scenario {
  const q = (prompt.split('\nQUESTION: ')[1] ?? '').toLowerCase();
  if (q.includes('[scenario:throw]')) return 'throw';
  if (q.includes('[scenario:empty]')) return 'empty';
  if (q.includes('[scenario:truncated_once]')) return 'truncated_once';
  if (q.includes('[scenario:truncated_twice]')) return 'truncated_twice';
  if (q.includes('[scenario:markup]')) return 'markup';
  if (q.includes('[scenario:too_long]')) return 'too_long';
  if (q.includes('[scenario:followed_injection]')) return 'followed_injection';
  if (q.includes('[scenario:leak_paraphrased]')) return 'leak_paraphrased';
  if (/system prompt|your instructions|initial prompt/.test(q)) return 'leak_verbatim';
  if (/capital of|weather|recipe|password|stock price/.test(q)) return 'refusal';
  return 'answer';
}

export function recordedResponse(s: Scenario): string {
  switch (s) {
    case 'too_long':
      return fixtures.too_long_unit.repeat(1000); // 7 000 chars
    case 'throw':
      throw new Error('503 Service Unavailable (fake)');
    case 'empty':
      return '';
    default:
      return fixtures[s];
  }
}

/** What Gemini returns when generation stops at maxOutputTokens: a half sentence, finishReason MAX_TOKENS, token counts. */
export function truncatedResponse(limit: number): GenAiResponse {
  return {
    text: fixtures.truncated,
    candidates: [{ finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: limit, thoughtsTokenCount: 300, totalTokenCount: 1800 + limit + 300 },
  };
}

/** Stand-in for `new GoogleGenAI({ apiKey }).models`: records every call, answers from the fixtures. */
export class FakeGemini implements GenAiClient {
  readonly calls: GenerateContentParameters[] = [];
  readonly models = {
    generateContent: (params: GenerateContentParameters): Promise<GenAiResponse> => {
      this.calls.push(params);
      const prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
      const limit = params.config?.maxOutputTokens ?? 0;
      const scenario = pickScenario(prompt);
      // The retry (a larger limit) completes the answer in `truncated_once`; `truncated_twice` is cut both times.
      if (scenario === 'truncated_twice' || (scenario === 'truncated_once' && this.calls.length === 1)) return Promise.resolve(truncatedResponse(limit));
      try {
        const text = scenario === 'truncated_once' ? fixtures.answer : recordedResponse(scenario);
        return Promise.resolve({ text, candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1800, candidatesTokenCount: 120, thoughtsTokenCount: 200, totalTokenCount: 2120 } });
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
  get last(): GenerateContentParameters {
    const c = this.calls.at(-1);
    if (!c) throw new Error('no Gemini call recorded');
    return c;
  }
}
