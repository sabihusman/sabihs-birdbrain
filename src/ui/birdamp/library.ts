import { confidenceWords } from '../confidence-text';
import { fmtClockShort, heardLabel, type SpeciesGroup } from '../../species/recent';

/**
 * BirdAmp Library rows (DECISIONS.md #110, Sabih's 2B): HEARD (this session), TODAY (today's saved sightings),
 * ALL BIRDS (everything spotted on this phone) and NEAR YOU (the local species list the Species tab uses, ✓ when
 * spotted). Rows carry only fields the app really has: no durations. Pure, so it is unit-tested.
 */
export type LibraryTab = 'heard' | 'today' | 'all' | 'near';
export const LIBRARY_TABS: ReadonlyArray<{ id: LibraryTab; label: string; search: string }> = [
  { id: 'heard', label: 'Heard', search: 'Search heard birds…' },
  { id: 'today', label: 'Today', search: 'Search today’s birds…' },
  { id: 'all', label: 'All birds', search: 'Search all your birds…' },
  { id: 'near', label: 'Near you', search: 'Search birds near you…' },
];

export interface LibraryRow {
  scientific: string;
  common: string;
  /** "best 95% · Heard once · last 11:15 AM" and the like. */
  detail: string;
  /** The number on the right ("95%"), or "✓" on NEAR YOU for a bird you've spotted. */
  right: string;
}

interface Named {
  common: string;
  scientific: string;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function heardRows(groups: readonly SpeciesGroup<Named>[], locale?: string): LibraryRow[] {
  return groups.map((g) => ({
    scientific: g.species.scientific,
    common: g.species.common,
    detail: `best ${pct(g.best)} · ${heardLabel(g.detections.length)} · last ${fmtClockShort(g.lastHeard, locale)}`,
    right: pct(g.best),
  }));
}

/** The saved-sighting fields the TODAY and ALL BIRDS tabs use. */
export interface SightingLike {
  scientific: string;
  common: string;
  lastTime: number;
  peakConfidence: number;
}

function seenLabel(n: number): string {
  return n === 1 ? 'Seen once' : n === 2 ? 'Seen twice' : `Seen ${n} times`;
}

/** One row per species, newest first. `since` keeps only sightings from then on (TODAY: local midnight). */
export function sightingRows(sightings: readonly SightingLike[], opts: { since?: number; now?: number; locale?: string } = {}): LibraryRow[] {
  const by = new Map<string, { common: string; best: number; last: number; n: number }>();
  for (const s of sightings) {
    if (opts.since != null && s.lastTime < opts.since) continue;
    const g = by.get(s.scientific);
    if (g) {
      g.n += 1;
      g.best = Math.max(g.best, s.peakConfidence);
      g.last = Math.max(g.last, s.lastTime);
    } else by.set(s.scientific, { common: s.common, best: s.peakConfidence, last: s.lastTime, n: 1 });
  }
  const today = startOfDay(opts.now ?? Date.now());
  return [...by.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .map(([scientific, g]) => ({
      scientific,
      common: g.common,
      detail: `best ${pct(g.best)} · ${seenLabel(g.n)} · last ${g.last >= today ? fmtClockShort(g.last, opts.locale) : new Date(g.last).toLocaleDateString(opts.locale, { day: 'numeric', month: 'short' })}`,
      right: pct(g.best),
    }));
}

/** NEAR YOU: alphabetical, ✓ for the ones spotted on this phone. */
export function nearRows(species: readonly Named[], spotted: ReadonlySet<string>): LibraryRow[] {
  return [...species]
    .sort((a, b) => a.common.localeCompare(b.common))
    .map((s) => ({ scientific: s.scientific, common: s.common, detail: spotted.has(s.scientific) ? '✓ spotted' : '', right: spotted.has(s.scientific) ? '✓' : '' }));
}

export function filterRows(rows: readonly LibraryRow[], query: string): LibraryRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.common.toLowerCase().includes(q) || r.scientific.toLowerCase().includes(q));
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The count line under the search field. */
export function countLine(tab: LibraryTab, o: { rows: number; detections?: number; place?: string | null; noLocation?: string | null }): string {
  switch (tab) {
    case 'heard':
      return o.rows ? `${plural(o.rows, 'bird')} · ${plural(o.detections ?? 0, 'detection')} · repeats within 30 s count once` : 'No birds yet this session';
    case 'today':
      return o.rows ? `${plural(o.rows, 'bird')} today · saved on this phone` : 'No birds saved today yet';
    case 'all':
      return o.rows ? `${plural(o.rows, 'bird')} you’ve spotted` : 'No birds spotted yet';
    case 'near':
      if (o.noLocation) return o.noLocation;
      return `${plural(o.rows, 'species', 'species')} near ${o.place ?? 'you'} · ✓ = you’ve spotted it`;
  }
}

/** The marquee's bird: "Lesser Redpoll — Acanthis flammea — 95% — Very likely". */
export function marqueeBird(s: Named, best: number): string {
  return `${s.common} — ${s.scientific} — ${pct(best)} — ${confidenceWords(best)}`;
}
