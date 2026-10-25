import { describe, expect, it } from 'vitest';
import { FOCUS_INTRO_KEY, focusIntroDone, markFocusIntroDone } from '../src/ui/focus-intro';
import { MemoryStorage } from './helpers/memory-storage';

describe('Focus introduction: once per session and day (DECISIONS.md #83)', () => {
  const day1 = new Date(2026, 9, 25, 9, 0).getTime();
  const laterSameDay = new Date(2026, 9, 25, 23, 59).getTime();
  const nextDay = new Date(2026, 9, 26, 0, 1).getTime();

  it('shows until the first start, then stays away for the rest of the day', () => {
    const s = new MemoryStorage();
    expect(focusIntroDone(s, day1)).toBe(false);
    markFocusIntroDone(s, day1);
    expect(focusIntroDone(s, laterSameDay)).toBe(true);
    expect(focusIntroDone(s, nextDay)).toBe(false);
    expect(s.getItem(FOCUS_INTRO_KEY)).toBe('2026-10-25');
  });

  it('a new session (empty storage) or a storage that throws shows it again, without errors', () => {
    expect(focusIntroDone(new MemoryStorage(), day1)).toBe(false);
    expect(focusIntroDone(null, day1)).toBe(false);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(focusIntroDone(throwing, day1)).toBe(false);
    expect(() => markFocusIntroDone(throwing, day1)).not.toThrow();
  });
});
