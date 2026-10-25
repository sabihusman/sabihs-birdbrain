import { describe, expect, it } from 'vitest';
import { WHY_VEIL_MAX, whyOutlineEdges, whyShares, whyVeilAlpha } from '../src/ui/viz/why-overlay';

describe('"Why this ID" overlay (DECISIONS.md #89)', () => {
  it('scales drops to the biggest one and ignores rises', () => {
    expect(Array.from(whyShares([0.4, 0.2, -0.1, 0]))).toEqual([1, 0.5, 0, 0]);
    expect(Array.from(whyShares([0, -0.2]))).toEqual([0, 0]);
  });

  it('leaves the most important part undarkened and darkens a part that did not matter the most', () => {
    expect(whyVeilAlpha(1)).toBe(0);
    expect(whyVeilAlpha(0)).toBe(WHY_VEIL_MAX);
    expect(whyVeilAlpha(0.5)).toBeCloseTo(WHY_VEIL_MAX / 2);
    expect(whyVeilAlpha(0.2)).toBeGreaterThan(whyVeilAlpha(0.8));
  });

  it('draws one outline around touching outlined parts, not a line between them', () => {
    // 3 time steps × 2 bands, map[t * 2 + f]; parts (0,0) and (1,0) are strong, the rest weak.
    const shares = [1, 0.1, 0.6, 0.2, 0.3, 0];
    const edges = whyOutlineEdges(shares, 3, 2);
    // A 2×1 block has 6 unit sides on its outline.
    expect(edges).toHaveLength(6);
    // No side between the two strong parts (t = 1, from f 0 to 1).
    expect(edges).not.toContainEqual({ t0: 1, f0: 0, t1: 1, f1: 1 });
    expect(edges).toContainEqual({ t0: 0, f0: 0, t1: 0, f1: 1 });
    expect(edges).toContainEqual({ t0: 2, f0: 0, t1: 2, f1: 1 });
    expect(edges).toContainEqual({ t0: 0, f0: 1, t1: 1, f1: 1 });
  });

  it('outlines nothing when no part changed the confidence', () => {
    expect(whyOutlineEdges(whyShares([0, 0, 0, 0]), 2, 2)).toEqual([]);
  });
});
