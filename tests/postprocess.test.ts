import { describe, expect, it } from 'vitest';
import { parseLabels, searchSpecies } from '../src/model/labels';
import { rankScores, selectDetections } from '../src/model/postprocess';

const labels = ['Turdus merula_Eurasian Blackbird', 'Erithacus rubecula_European Robin', 'Dog_Dog', 'Parus major_Great Tit', "Zosterops simplex_Swinhoe's White-eye"];
const species = parseLabels(labels);

describe('labels', () => {
  it('splits scientific and common names and flags non-bird classes', () => {
    expect(species[0]).toMatchObject({ index: 0, scientific: 'Turdus merula', common: 'Eurasian Blackbird', isBird: true });
    expect(species[2]).toMatchObject({ scientific: 'Dog', common: 'Dog', isBird: false });
  });

  it('search ranks prefix matches first and ignores apostrophes/case', () => {
    expect(searchSpecies(species, 'rob')[0].common).toBe('European Robin');
    expect(searchSpecies(species, 'great')[0].common).toBe('Great Tit');
    expect(searchSpecies(species, 'swinhoes')[0].common).toBe("Swinhoe's White-eye");
    expect(searchSpecies(species, 'turdus')[0].scientific).toBe('Turdus merula');
    expect(searchSpecies(species, 'zzz')).toEqual([]);
  });
});

describe('rankScores + selectDetections (multi-label)', () => {
  const probs = new Float32Array([0.9, 0.4, 0.7, 0.2, 0.005]);

  it('returns every class above the floor, sorted descending', () => {
    const ranked = rankScores(probs, 0.01);
    expect(ranked.map((s) => s.index)).toEqual([0, 2, 1, 3]);
  });

  it('keeps all species above threshold, not just the top one', () => {
    const ranked = rankScores(probs, 0.01);
    const dets = selectDetections(ranked, species, { threshold: 0.3, applyGeo: false, includeNonBird: true });
    expect(dets.map((d) => d.index)).toEqual([0, 2, 1]);
  });

  it('hides non-bird classes unless asked', () => {
    const ranked = rankScores(probs, 0.01);
    const dets = selectDetections(ranked, species, { threshold: 0.3, applyGeo: false, includeNonBird: false });
    expect(dets.map((d) => d.index)).toEqual([0, 1]);
  });

  it('applies the location/season filter', () => {
    const geo = { probs: new Float32Array([0.5, 0.01, 0.9, 0.9, 0.9]), threshold: 0.03 };
    const ranked = rankScores(probs, 0.01, geo);
    expect(ranked.find((s) => s.index === 1)?.inRange).toBe(false);
    const dets = selectDetections(ranked, species, { threshold: 0.3, applyGeo: true, includeNonBird: true });
    expect(dets.map((d) => d.index)).toEqual([0, 2]);
    const unfiltered = selectDetections(ranked, species, { threshold: 0.3, applyGeo: false, includeNonBird: true });
    expect(unfiltered.map((d) => d.index)).toEqual([0, 2, 1]);
  });

  it('returns nothing when everything is below threshold', () => {
    expect(selectDetections(rankScores(probs), species, { threshold: 0.95, applyGeo: false, includeNonBird: true })).toEqual([]);
  });
});
