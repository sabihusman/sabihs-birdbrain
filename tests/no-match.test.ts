import { describe, expect, it } from 'vitest';
import type { Species } from '../src/model/labels';
import { closestCandidates, NEAR_MISS_MAX, noMatchLines } from '../src/species/no-match';

const sp = (index: number, common: string, isBird = true): Species => ({ index, label: `S${index}_${common}`, scientific: `S${index}`, common, isBird });
const SPECIES = [sp(0, 'Thrush'), sp(1, 'Robin'), sp(2, 'Wren'), sp(3, 'Dog', false), sp(4, 'Finch'), sp(5, 'Jay')];
const w = (pairs: Array<[number, number]>) => ({ scores: pairs.map(([index, prob]) => ({ index, prob, inRange: true })) });

describe('a recording with no confident match (DECISIONS.md #104)', () => {
  it('keeps the best score per species under the minimum, highest first, at most three', () => {
    const near = closestCandidates([w([[0, 0.45], [1, 0.2], [3, 0.6]]), w([[0, 0.3], [2, 0.35], [4, 0.05], [5, 0.12]])], SPECIES, 0.7, false);
    expect(near).toEqual([
      { scientific: 'S0', prob: 0.45 },
      { scientific: 'S2', prob: 0.35 },
      { scientific: 'S1', prob: 0.2 },
    ]);
    expect(near.length).toBeLessThanOrEqual(NEAR_MISS_MAX);
  });

  it('leaves out matches above the minimum, noise under the floor, and non-birds unless shown', () => {
    expect(closestCandidates([w([[0, 0.9], [4, 0.05]])], SPECIES, 0.7, false)).toEqual([]);
    expect(closestCandidates([w([[3, 0.5]])], SPECIES, 0.7, true)).toEqual([{ scientific: 'S3', prob: 0.5 }]);
  });

  it('says it plainly, with the closest names or without', () => {
    expect(noMatchLines([{ common: 'Swainson’s Thrush', prob: 0.45 }, { common: 'American Robin', prob: 0.31 }], 0.7)).toEqual([
      'It heard something, but no bird reached your minimum of 70%.',
      'Closest: Swainson’s Thrush 45%, American Robin 31%. Not sure enough to name.',
    ]);
    expect(noMatchLines([], 0.7)).toEqual(['Nothing came close to your minimum of 70%.']);
  });
});
