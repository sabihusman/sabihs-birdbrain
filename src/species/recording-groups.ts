import type { RecordingMeta } from '../storage/types';

/**
 * Recordings grouped by bird (DECISIONS.md #97): one group per top species (the most confident bird in each
 * recording), plus one group for recordings with no bird found. Groups are ordered by their newest recording,
 * and each group lists its recordings newest first.
 */
export interface RecordingGroup {
  /** Scientific name of the bird, or null for "No bird found". */
  scientific: string | null;
  common: string | null;
  recordings: RecordingMeta[];
  /** Best confidence for this bird over the group's recordings (0 for "No bird found"). */
  best: number;
  /** Newest recording time in the group. */
  latest: number;
}

export function groupRecordingsByBird(recs: readonly RecordingMeta[]): RecordingGroup[] {
  const groups = new Map<string, RecordingGroup>();
  for (const r of recs) {
    const top = r.summary[0];
    const key = top ? top.scientific : '';
    let g = groups.get(key);
    if (!g) {
      g = { scientific: top?.scientific ?? null, common: top?.common ?? null, recordings: [], best: 0, latest: 0 };
      groups.set(key, g);
    }
    g.recordings.push(r);
    if (top) g.best = Math.max(g.best, top.maxConfidence);
    g.latest = Math.max(g.latest, r.createdAt);
  }
  for (const g of groups.values()) g.recordings.sort((a, b) => b.createdAt - a.createdAt);
  return Array.from(groups.values()).sort((a, b) => b.latest - a.latest);
}
