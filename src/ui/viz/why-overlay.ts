/**
 * How the "Why this ID" result is drawn on the spectrogram (DECISIONS.md #89).
 *
 * A fill in the species colour blended into the inferno colour map (purple, red, orange: the same hues
 * as many species colours). Instead the result works with any colour: every part of the window is
 * darkened by how little it mattered, so the parts the model relied on stay at full brightness, and the
 * parts it relied on most get one outline around them, in the species colour on a dark edge.
 */

/** Darkening of a part that did not matter at all (0..1 alpha of near-black). */
export const WHY_VEIL_MAX = 0.65;
/** Parts at or above this share of the biggest drop are outlined. */
export const WHY_OUTLINE_SHARE = 0.5;

/** Each cell's drop as a share (0..1) of the biggest drop; all zero when nothing dropped. */
export function whyShares(map: ArrayLike<number>): Float32Array {
  let max = 0;
  for (let i = 0; i < map.length; i++) max = Math.max(max, map[i]);
  const out = new Float32Array(map.length);
  if (max <= 0) return out;
  for (let i = 0; i < map.length; i++) out[i] = Math.max(0, Math.min(1, map[i] / max));
  return out;
}

/** Alpha of the near-black veil over a cell: none on the most important part, WHY_VEIL_MAX where nothing changed. */
export function whyVeilAlpha(share: number): number {
  return WHY_VEIL_MAX * (1 - Math.max(0, Math.min(1, share)));
}

/** One side of a grid cell, in grid units: t along time (0..timeSteps), f along bands (0..freqBands, low to high). */
export interface GridEdge {
  t0: number;
  f0: number;
  t1: number;
  f1: number;
}

/**
 * The outline of the outlined cells (share ≥ WHY_OUTLINE_SHARE) as grid edges: only the sides that face a
 * cell that is not outlined (or the edge of the grid), so touching cells get one outline around them all.
 * The map is laid out as map[t * freqBands + f].
 */
export function whyOutlineEdges(shares: ArrayLike<number>, timeSteps: number, freqBands: number, threshold = WHY_OUTLINE_SHARE): GridEdge[] {
  const strong = (t: number, f: number) => t >= 0 && t < timeSteps && f >= 0 && f < freqBands && shares[t * freqBands + f] >= threshold && shares[t * freqBands + f] > 0;
  const edges: GridEdge[] = [];
  for (let t = 0; t < timeSteps; t++) {
    for (let f = 0; f < freqBands; f++) {
      if (!strong(t, f)) continue;
      if (!strong(t - 1, f)) edges.push({ t0: t, f0: f, t1: t, f1: f + 1 });
      if (!strong(t + 1, f)) edges.push({ t0: t + 1, f0: f, t1: t + 1, f1: f + 1 });
      if (!strong(t, f - 1)) edges.push({ t0: t, f0: f, t1: t + 1, f1: f });
      if (!strong(t, f + 1)) edges.push({ t0: t, f0: f + 1, t1: t + 1, f1: f + 1 });
    }
  }
  return edges;
}
