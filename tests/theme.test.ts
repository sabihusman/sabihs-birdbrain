import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, isTheme, otherTheme, readStoredTheme, storeTheme, THEME_KEY } from '../src/theme/theme';
import { MemoryStorage } from './helpers/memory-storage';

describe('theme choice', () => {
  it('defaults to dark whatever the device prefers, and remembers a choice', () => {
    const s = new MemoryStorage();
    expect(readStoredTheme(s)).toBe('dark');
    expect(DEFAULT_THEME).toBe('dark');
    expect(storeTheme('light', s)).toBe(true);
    expect(readStoredTheme(s)).toBe('light');
    expect(s.getItem(THEME_KEY)).toBe('light');
    s.setItem(THEME_KEY, 'neon');
    expect(readStoredTheme(s)).toBe('dark');
    expect(readStoredTheme(null)).toBe('dark');
  });

  it('falls back to dark when storage throws', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(readStoredTheme(broken)).toBe('dark');
    expect(storeTheme('light', broken)).toBe(false);
    expect(isTheme('light')).toBe(true);
    expect(otherTheme('dark')).toBe('light');
  });
});
