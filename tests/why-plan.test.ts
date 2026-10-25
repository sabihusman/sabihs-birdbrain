import { describe, expect, it } from 'vitest';
import { chosenButtonText, estimateText, isSlowBackend, passesFor, planWhy, whyPlanNote } from '../src/ui/why-plan';

describe('"Why this ID" on phones without WebGL (DECISIONS.md #85)', () => {
  it('runs the chosen level with WebGL, and Coarse on WebAssembly or plain JavaScript', () => {
    expect([passesFor('coarse'), passesFor('medium'), passesFor('fine')]).toEqual([25, 49, 97]);
    expect(planWhy('medium', 'webgl', 120)).toMatchObject({ resolution: 'medium', passes: 49, reduced: false });
    expect(planWhy('medium', 'wasm', 1500)).toMatchObject({ resolution: 'coarse', passes: 25, chosen: 'medium', chosenPasses: 49, reduced: true });
    expect(planWhy('fine', 'cpu', null)).toMatchObject({ resolution: 'coarse', reduced: true, chosenPasses: 97 });
    expect(planWhy('coarse', 'wasm', 1500).reduced).toBe(false); // already the lightest
    expect(planWhy('medium', null, null).reduced).toBe(false); // not loaded: nothing to judge
    expect([isSlowBackend('wasm'), isSlowBackend('cpu'), isSlowBackend('webgl'), isSlowBackend(undefined)]).toEqual([true, true, false, false]);
  });

  it('gives a time only when this phone measured one', () => {
    expect(estimateText(25, null)).toBe('');
    expect(estimateText(25, 200)).toBe('a few seconds');
    expect(estimateText(25, 1500)).toBe('about 40 s');
    expect(estimateText(49, 2000)).toBe('about 2 min');
  });

  it('says what runs and why, and offers the chosen level with its cost', () => {
    const slow = planWhy('medium', 'wasm', 2000);
    expect(whyPlanNote(slow)).toBe('Coarse detail, 25 model passes, about 50 s. Less detail on this phone (no graphics acceleration) to save time and battery.');
    expect(chosenButtonText(slow)).toBe('Run at Medium (49 passes, about 2 min)');
    expect(whyPlanNote(planWhy('medium', 'webgl', 100))).toBe('Medium detail, 49 model passes, a few seconds.');
  });
});
