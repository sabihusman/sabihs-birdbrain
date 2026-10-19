import type { GenerateContentParameters } from '@google/genai';
import { readFileSync } from 'node:fs';
import type { GenAiClient } from '../src/ask.js';

export type Scenario = 'answer' | 'refusal' | 'leak_verbatim' | 'leak_paraphrased' | 'followed_injection' | 'markup' | 'too_long' | 'throw' | 'empty';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/gemini-responses.json', import.meta.url), 'utf8')) as Record<string, string>;

/** Which recorded reply a prompt gets: chosen from the QUESTION line, as a real model would react to it. */
export function pickScenario(prompt: string): Scenario {
  const q = (prompt.split('\nQUESTION: ')[1] ?? '').toLowerCase();
  if (q.includes('[scenario:throw]')) return 'throw';
  if (q.includes('[scenario:empty]')) return 'empty';
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

/** Stand-in for `new GoogleGenAI({ apiKey }).models`: records every call, answers from the fixtures. */
export class FakeGemini implements GenAiClient {
  readonly calls: GenerateContentParameters[] = [];
  readonly models = {
    generateContent: async (params: GenerateContentParameters) => {
      this.calls.push(params);
      const prompt = typeof params.contents === 'string' ? params.contents : JSON.stringify(params.contents);
      return { text: recordedResponse(pickScenario(prompt)) };
    },
  };
  get last(): GenerateContentParameters {
    const c = this.calls[this.calls.length - 1];
    if (!c) throw new Error('no Gemini call recorded');
    return c;
  }
}
