import { describe, expect, it } from 'vitest';
import { hashString, oklchToRgb, speciesColor, withAlpha } from '../src/species/colors';

describe('speciesColor', () => {
  it('is deterministic', () => {
    expect(speciesColor('Turdus merula')).toEqual(speciesColor('Turdus merula'));
    expect(hashString('abc')).toBe(hashString('abc'));
  });

  it('produces valid rgb and css', () => {
    const c = speciesColor('Parus major');
    for (const ch of c.rgb) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(255);
    }
    expect(c.css).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(withAlpha(c, 0.5)).toMatch(/^rgba\(\d+, \d+, \d+, 0.5\)$/);
  });

  it('gives different species different hues', () => {
    const names = ['Turdus merula', 'Erithacus rubecula', 'Parus major', 'Cyanistes caeruleus', 'Fringilla coelebs', 'Sylvia atricapilla'];
    const hues = names.map((n) => speciesColor(n).hue);
    for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) expect(Math.abs(hues[i] - hues[j])).toBeGreaterThan(1);
  });

  it('keeps mid lightness so colours read on light and dark backgrounds', () => {
    // Relative luminance stays away from both extremes for every hue.
    for (let h = 0; h < 360; h += 15) {
      const [r, g, b] = oklchToRgb(0.64, 0.15, h);
      const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      expect(Y).toBeGreaterThan(0.12);
      expect(Y).toBeLessThan(0.5);
    }
  });

  it('converts OKLCH grey to neutral rgb', () => {
    const [r, g, b] = oklchToRgb(0.5, 0, 0);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
  });
});
