import type { Species } from './labels';

export interface Score {
  index: number;
  prob: number;
  /** False when the location/season filter says the species is not expected here. */
  inRange: boolean;
}

export interface GeoMask {
  /** Geo-model probability per class. */
  probs: Float32Array;
  threshold: number;
}

/** Keep every class at or above `floor`, sorted by probability, annotated with the geo filter. */
export function rankScores(probs: Float32Array, floor = 0.01, geo: GeoMask | null = null): Score[] {
  const out: Score[] = [];
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (p >= floor) out.push({ index: i, prob: p, inRange: geo ? geo.probs[i] >= geo.threshold : true });
  }
  out.sort((a, b) => b.prob - a.prob);
  return out;
}

export interface FilterOptions {
  threshold: number;
  /** Apply the location/season filter (drop out-of-range species). */
  applyGeo: boolean;
  /** Include BirdNET's non-bird classes (Dog, Engine, Noise, ...). */
  includeNonBird: boolean;
}

/**
 * Multi-label selection: every species above the threshold is a detection,
 * not just the top one. BirdNET is trained with per-class sigmoids, so several
 * classes can legitimately be high in the same window.
 */
export function selectDetections(scores: Score[], species: Species[], opts: FilterOptions): Score[] {
  return scores.filter((s) => {
    if (s.prob < opts.threshold) return false;
    if (opts.applyGeo && !s.inRange) return false;
    const sp = species[s.index];
    if (!opts.includeNonBird && sp && !sp.isBird) return false;
    return true;
  });
}

/** Format a probability as a percentage string for display. */
export function formatConfidence(p: number): string {
  return `${Math.round(p * 100)}%`;
}
