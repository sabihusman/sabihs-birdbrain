/** Card summaries for the Map tab (DECISIONS.md #72). Pure, unit-tested. */

export interface SightingLike {
  scientific: string;
  common: string;
  lat: number | null;
  lon: number | null;
  firstTime: number;
  lastTime: number;
}

export interface BirdSummary<S extends SightingLike> {
  scientific: string;
  common: string;
  /** Located sightings, newest first. */
  sightings: S[];
  last: number;
}

/** One entry per species with a located sighting, the most recently seen species first. */
export function summarizeBirds<S extends SightingLike>(sightings: S[]): BirdSummary<S>[] {
  const m = new Map<string, BirdSummary<S>>();
  for (const s of sightings) {
    if (s.lat == null || s.lon == null) continue;
    const b = m.get(s.scientific) ?? { scientific: s.scientific, common: s.common, sightings: [], last: 0 };
    b.sightings.push(s);
    b.last = Math.max(b.last, s.lastTime);
    m.set(s.scientific, b);
  }
  const out = Array.from(m.values());
  for (const b of out) b.sightings.sort((a, c) => c.lastTime - a.lastTime);
  return out.sort((a, b) => b.last - a.last || a.common.localeCompare(b.common));
}

/** "Oct 22", or "Oct 22, 2025" outside the current year. */
export function shortDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "1 sighting · Oct 20" or "6 sightings · last Oct 22". */
export function birdCardLine(count: number, last: number, now = Date.now()): string {
  return count === 1 ? `1 sighting · ${shortDate(last, now)}` : `${count} sightings · last ${shortDate(last, now)}`;
}

/** "14 sightings · 7 species" */
export function placeCardLine(sightings: number, species: number): string {
  return `${sightings} sighting${sightings === 1 ? '' : 's'} · ${species} species`;
}

/** Count line for the Birds view: "13 species · 23 sightings with a location". */
export function birdsCountLine(species: number, sightings: number): string {
  return `${species} species · ${sightings} sighting${sightings === 1 ? '' : 's'} with a location`;
}
