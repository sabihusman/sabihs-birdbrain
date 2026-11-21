import { describe, expect, it } from 'vitest';
import { FLIP_HINT_MS, FLIP_HINT_TEXT, flipLabels, placeHint } from '../src/ui/flip';
import { cleanProperties, SCHEMA } from '../src/app/usage-counts';

describe('⇅ Flip (DECISIONS.md #126)', () => {
  it('says what it does in both states, for the eye and for screen readers', () => {
    expect(flipLabels(false)).toEqual({ text: '⇅ Flip', aria: 'Turn the screen upside down, for pointing the phone at a bird' });
    expect(flipLabels(true)).toEqual({ text: '⇅ Flipped', aria: 'Turn the screen back' });
    expect(FLIP_HINT_TEXT).toBe('Pointing the bottom at a bird? Tap ⇅ Flip to turn the screen.');
    expect(FLIP_HINT_MS).toBe(3000);
  });

  it('puts the bubble above a low panel (Focus) and under a button in the top half (Consolidated, BirdAmp)', () => {
    const viewport = { width: 390, height: 844 };
    // Focus: Flip at the bottom right, the panel starts higher up; the bubble sits above the panel, tip under the button.
    const low = placeHint({ top: 680, bottom: 724, right: 374, width: 66 }, 600, viewport);
    expect(low).toEqual({ side: 'above', right: 16, offset: 844 - 600 + 12, tipRight: 26 });
    // Consolidated: Flip near the top; the bubble goes under it.
    const high = placeHint({ top: 300, bottom: 344, right: 358, width: 66 }, 120, viewport);
    expect(high).toEqual({ side: 'below', right: 32, offset: 358, tipRight: 26 });
    // Never against the window's edge.
    expect(placeHint({ top: 700, bottom: 744, right: 390, width: 10 }, 700, viewport)).toMatchObject({ right: 8, tipRight: 10 });
  });

  it('counts a flip by layout only', () => {
    expect(SCHEMA.screen_flipped).toBeDefined();
    expect(cleanProperties({ event: 'screen_flipped', layout: 'focus' })).toEqual({ layout: 'focus' });
    expect(cleanProperties({ event: 'screen_flipped', layout: 'upside-down' } as never)).toEqual({});
  });
});
