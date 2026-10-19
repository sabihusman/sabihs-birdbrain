/**
 * Display-only grouping for Listen → "Recent sightings" and the live results
 * list. Nothing here touches storage: the per-window hits stay individual in
 * IndexedDB (and keep feeding sightings, history, the heat map, clips and
 * ticks); this module only decides how the Listen screen shows them.
 */

/**
 * Hits of one species with no more than this many seconds between one hit and
 * the next count as one detection. The gap is rolling, so a bird singing
 * steadily stays a single detection however long it goes on.
 */
export const LUMP_GAP_SECONDS = 30;

/** One analysis window that identified a species. */
export interface RecentHit {
  /** Epoch ms of the window start. */
  time: number;
  confidence: number;
}

/** Several hits of one species lumped by the rolling gap. */
export interface LumpedDetection {
  /** Epoch ms of the first hit. */
  start: number;
  /** Epoch ms of the last hit. */
  end: number;
  /** Number of analysis windows in the lump. */
  hits: number;
  /** Highest confidence among those windows. */
  best: number;
}

/** Lump hits (any order) into detections, oldest first. */
export function lumpHits(hits: readonly RecentHit[], gapMs = LUMP_GAP_SECONDS * 1000): LumpedDetection[] {
  const sorted = hits.slice().sort((a, b) => a.time - b.time);
  const out: LumpedDetection[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.time - last.end <= gapMs) {
      last.end = h.time;
      last.hits += 1;
      if (h.confidence > last.best) last.best = h.confidence;
    } else {
      out.push({ start: h.time, end: h.time, hits: 1, best: h.confidence });
    }
  }
  return out;
}

/** One card on the Listen screen: a species with its lumped detections. */
export interface SpeciesGroup<S> {
  /** Grouping key (the scientific name). */
  key: string;
  species: S;
  /** Lumped detections, newest first. */
  detections: LumpedDetection[];
  /** Best confidence over every hit. */
  best: number;
  /** End time of the newest detection. */
  lastHeard: number;
  /** Total analysis windows behind the card. */
  hitCount: number;
}

export interface KeyedHit<S> extends RecentHit {
  key: string;
  species: S;
}

/**
 * Group hits by species and lump each species' hits; cards are ordered by last
 * heard, newest first, so a fresh hit moves its species to the top. One card
 * per species, never two.
 */
export function groupRecent<S>(hits: readonly KeyedHit<S>[], gapMs = LUMP_GAP_SECONDS * 1000): SpeciesGroup<S>[] {
  const byKey = new Map<string, KeyedHit<S>[]>();
  for (const h of hits) {
    const list = byKey.get(h.key);
    if (list) list.push(h);
    else byKey.set(h.key, [h]);
  }
  const groups: SpeciesGroup<S>[] = [];
  for (const [key, list] of byKey) {
    const detections = lumpHits(list, gapMs).reverse();
    groups.push({
      key,
      species: list[0].species,
      detections,
      best: Math.max(...list.map((h) => h.confidence)),
      lastHeard: detections[0].end,
      hitCount: list.length,
    });
  }
  return groups.sort((a, b) => b.lastHeard - a.lastHeard || a.key.localeCompare(b.key));
}

/** "Heard once" / "Heard 4 times" (N = lumped detections, not raw hits). */
export function heardLabel(detections: number): string {
  return detections === 1 ? 'Heard once' : `Heard ${detections} times`;
}

/** Clock time with seconds, e.g. "3:34:15 PM". */
export function fmtClock(ms: number, locale?: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** Clock time without seconds, e.g. "3:34 PM" (used in the screen-reader summary). */
export function fmtClockShort(ms: number, locale?: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Label for one lumped detection: a range when it spans several hits
 * ("3:34:15–3:34:20 PM"), else the single time. The shared AM/PM suffix is
 * written once when both ends carry the same one.
 */
export function detectionTimeLabel(d: LumpedDetection, locale?: string): string {
  const start = fmtClock(d.start, locale);
  if (d.hits === 1 || d.end === d.start) return start;
  const end = fmtClock(d.end, locale);
  const suffix = /\s[AP]M$/i.exec(start)?.[0];
  if (suffix && end.endsWith(suffix)) return `${start.slice(0, -suffix.length)}–${end}`;
  return `${start}–${end}`;
}

/** Screen-reader summary: "Eastern Bluebird, heard 4 times, best 100%, last at 3:34 PM". */
export function describeGroup(common: string, g: Pick<SpeciesGroup<unknown>, 'detections' | 'best' | 'lastHeard'>, locale?: string): string {
  const n = g.detections.length;
  const heard = n === 1 ? 'heard once' : `heard ${n} times`;
  return `${common}, ${heard}, best ${Math.round(g.best * 100)}%, last at ${fmtClockShort(g.lastHeard, locale)}`;
}

/** Expanded-card state: toggles a key in the set and returns whether it is now expanded. */
export function toggleExpanded(expanded: Set<string>, key: string): boolean {
  if (expanded.has(key)) {
    expanded.delete(key);
    return false;
  }
  expanded.add(key);
  return true;
}
