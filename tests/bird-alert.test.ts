import { describe, expect, it } from 'vitest';
import { ALERT_GAP_MS, buzz, canVibrate, NewBirdTracker, VIBRATE_MS } from '../src/app/bird-alert';
import { DEFAULT_SETTINGS, sanitize } from '../src/app/settings';
import { BIRD_ALERT_MORE } from '../src/ui/views/settings';

describe('a bird is found (DECISIONS.md #134)', () => {
  it('counts a bird once while it keeps singing, and again after 30 s without it', () => {
    const t = new NewBirdTracker();
    expect(t.check(['Turdus migratorius'], 0)).toEqual(['Turdus migratorius']);
    expect(t.check(['Turdus migratorius'], 1_500)).toEqual([]);
    // Steady singing for minutes: the gap is between hearings, not since the first one.
    for (let s = 3; s < 300; s += 1.5) expect(t.check(['Turdus migratorius'], s * 1000)).toEqual([]);
    expect(t.check(['Turdus migratorius'], 300_000 + ALERT_GAP_MS + 1)).toEqual(['Turdus migratorius']);
  });

  it('finds each new bird in a window, once, and starts over for a new session', () => {
    const t = new NewBirdTracker();
    expect(t.check(['A', 'B', 'A'], 0)).toEqual(['A', 'B']);
    expect(t.check(['A', 'C'], 1000)).toEqual(['C']);
    t.reset();
    expect(t.check(['A'], 2000)).toEqual(['A']);
  });

  it('buzzes only where the browser offers vibration, and never throws', () => {
    const calls: unknown[] = [];
    const android = { vibrate: (p: number) => (calls.push(p), true) };
    expect(canVibrate(android)).toBe(true);
    expect(buzz(android)).toBe(true);
    expect(calls).toEqual([VIBRATE_MS]);
    const iphone = {};
    expect(canVibrate(iphone)).toBe(false);
    expect(buzz(iphone)).toBe(false);
    expect(buzz({ vibrate: () => { throw new Error('blocked'); } })).toBe(false);
    expect(buzz(undefined)).toBe(false);
  });

  it('is on unless switched off, and says plainly that iPhones do not buzz', () => {
    expect(DEFAULT_SETTINGS.birdAlert).toBe(true);
    expect(sanitize({ ...DEFAULT_SETTINGS, birdAlert: false }).birdAlert).toBe(false);
    expect(sanitize({ ...DEFAULT_SETTINGS, birdAlert: undefined as never }).birdAlert).toBe(true);
    expect(BIRD_ALERT_MORE).toContain('iPhones do not let websites vibrate');
  });
});
