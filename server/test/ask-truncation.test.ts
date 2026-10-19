import { describe, expect, it } from 'vitest';
import { ANSWER_MAX_OUTPUT_TOKENS, ANSWER_RETRY_OUTPUT_TOKENS, ANSWER_THINKING_LEVEL, CUT_SHORT_SUFFIX, createGeminiModel, finishCutAnswer, SYSTEM_INSTRUCTION } from '../src/ask.js';
import { FakeGemini } from './fake-gemini.js';

const input = (scenario: string) => ({ systemInstruction: SYSTEM_INSTRUCTION, prompt: `<source>[Section: Range]\nBreeds in the north.</source>\nQUESTION: where does it live? [scenario:${scenario}]` });

describe('answers cut at the output limit', () => {
  it('sends the output budget and a low thinking level on every call and asks for at most 120 words', async () => {
    const gemini = new FakeGemini();
    const model = createGeminiModel('fake-key', 'gemini-test', gemini, () => undefined);
    await model(input('answer'));
    expect(gemini.calls).toHaveLength(1);
    expect(gemini.last.config?.maxOutputTokens).toBe(ANSWER_MAX_OUTPUT_TOKENS);
    // Gemini 3 models take thinkingLevel; the legacy thinkingBudget must not be sent alongside it (400 from the API).
    expect(gemini.last.config?.thinkingConfig?.thinkingLevel).toBe(ANSWER_THINKING_LEVEL);
    expect(['MINIMAL', 'LOW']).toContain(ANSWER_THINKING_LEVEL);
    expect(gemini.last.config?.thinkingConfig?.thinkingBudget).toBeUndefined();
    expect(SYSTEM_INSTRUCTION).toContain('at most 120 words');
  });

  it('retries once with the larger limit when the finish reason is MAX_TOKENS, and returns the complete retry', async () => {
    const gemini = new FakeGemini();
    const lines: string[] = [];
    const model = createGeminiModel('fake-key', 'gemini-test', gemini, (l) => lines.push(l));
    const text = await model(input('truncated_once'));
    expect(gemini.calls.map((c) => c.config?.maxOutputTokens)).toEqual([ANSWER_MAX_OUTPUT_TOKENS, ANSWER_RETRY_OUTPUT_TOKENS]);
    expect(text).not.toContain(CUT_SHORT_SUFFIX);
    expect(text.endsWith('the')).toBe(false);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/finish=MAX_TOKENS/);
    expect(lines[1]).toMatch(/finish=STOP/);
  });

  it('after a second cut returns the complete sentences plus "(answer cut short)", never a half sentence', async () => {
    const gemini = new FakeGemini();
    const model = createGeminiModel('fake-key', 'gemini-test', gemini, () => undefined);
    const text = await model(input('truncated_twice'));
    expect(gemini.calls).toHaveLength(2);
    expect(text).toBe(`The Wikipedia article does not mention Des Moines, though it notes that the species breeds across the northern forests. [Range] ${CUT_SHORT_SUFFIX}`);
  });

  it('logs the finish reason and token counts but never the question or the answer', async () => {
    const gemini = new FakeGemini();
    const lines: string[] = [];
    const model = createGeminiModel('fake-key', 'gemini-test', gemini, (l) => lines.push(l));
    await model(input('truncated_twice'));
    for (const line of lines) {
      expect(line).toMatch(/^\[ask\] attempt=\d limit=\d+ finish=MAX_TOKENS prompt_tokens=1800 answer_tokens=\d+ thinking_tokens=300 total_tokens=\d+ cost_usd=unknown cached=false$/);
      expect(line).not.toMatch(/Des Moines|where does it live/);
    }
  });

  it('finishCutAnswer keeps whole sentences with their citations and handles text without any sentence end', () => {
    expect(finishCutAnswer('It eats seeds. [Diet] It also eats')).toBe(`It eats seeds. [Diet] ${CUT_SHORT_SUFFIX}`);
    expect(finishCutAnswer('It eats seeds! It also')).toBe(`It eats seeds! ${CUT_SHORT_SUFFIX}`);
    expect(finishCutAnswer('No sentence end here')).toBe(`No sentence end here ${CUT_SHORT_SUFFIX}`);
    expect(finishCutAnswer('   ')).toBe('');
  });
});
