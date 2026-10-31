import type { Score } from '../model/postprocess';
import type { Species } from '../model/labels';

/**
 * A recording analysed with nothing above the minimum (DECISIONS.md #104): say so plainly, name the closest
 * guesses that did not make it, and give one next step, instead of a bare "Nothing above the threshold".
 */
export interface NearMiss {
  scientific: string;
  prob: number;
}

/** Below this, a guess is noise rather than a near miss (the same floor Listen uses for "below your minimum"). */
export const NEAR_MISS_FLOOR = 0.1;
export const NEAR_MISS_MAX = 3;

/** The best score per species across all windows that stayed under the minimum, highest first. */
export function closestCandidates(windows: ReadonlyArray<{ scores: Score[] }>, species: ReadonlyArray<Species>, threshold: number, includeNonBird: boolean): NearMiss[] {
  const best = new Map<number, number>();
  for (const w of windows) {
    for (const s of w.scores) {
      if (s.prob < NEAR_MISS_FLOOR || s.prob >= threshold) continue;
      const sp = species[s.index];
      if (!sp || (!sp.isBird && !includeNonBird)) continue;
      if ((best.get(s.index) ?? 0) < s.prob) best.set(s.index, s.prob);
    }
  }
  return Array.from(best.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, NEAR_MISS_MAX)
    .map(([index, prob]) => ({ scientific: species[index].scientific, prob }));
}

export const NO_MATCH_TITLE = 'No confident match';
export const NO_MATCH_TIP = 'What helps: move closer and record for longer, 20 to 30 seconds.';

/** "It heard something…" with the closest names, or the plain version when there was nothing near. */
export function noMatchLines(closest: ReadonlyArray<{ common: string; prob: number }>, threshold: number): string[] {
  const min = `${Math.round(threshold * 100)}%`;
  if (closest.length === 0) return [`Nothing came close to your minimum of ${min}.`];
  const names = closest.map((c) => `${c.common} ${Math.round(c.prob * 100)}%`).join(', ');
  return [`It heard something, but no bird reached your minimum of ${min}.`, `Closest: ${names}. Not sure enough to name.`];
}
