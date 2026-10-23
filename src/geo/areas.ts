/**
 * Areas of about 1 km across for the Map tab's Places view (DECISIONS.md #73). Pure functions only;
 * naming an area lives in src/geo/geocode.ts.
 *
 * Leader clustering in time order, oldest sighting first, so the areas already on the phone stay
 * where they are as new sightings arrive:
 * - a sighting less than 1 km from the nearest existing centre joins that nearest area (within
 *   500 m it is inside the area's circle; 500 m to 1 km is the edge rule: it still joins, because
 *   starting a new area there would put two centres less than 1 km apart and the circles would
 *   overlap);
 * - otherwise (1 km or more from every centre) it starts a new area centred on itself.
 * Centres never move, so every two centres are at least 1 km apart and the 1 km-diameter circles
 * drawn round them never overlap.
 */

export interface Locatable {
  lat: number | null;
  lon: number | null;
  scientific: string;
  firstTime: number;
  lastTime: number;
}

export interface Cell {
  /** "41.673,-93.698" */
  key: string;
  lat: number;
  lon: number;
}

export interface Area<S extends Locatable> {
  /** The rounded centre's key, e.g. "41.672,-93.698"; also the geocode cache key. */
  key: string;
  /** The centre: the position of the area's oldest sighting. Never sent anywhere. */
  lat: number;
  lon: number;
  /** The centre rounded to 3 decimals (about 100 m): the only thing sent to the geocoder. */
  cell: Cell;
  /** Sightings in the area, newest first. */
  sightings: S[];
  /** Scientific names, most sightings first. */
  species: string[];
}

/** Radius of the circle drawn round an area's centre: a 1 km-diameter area. */
export const AREA_RADIUS_M = 500;
/** Minimum distance between two area centres, so the circles never overlap. */
export const AREA_SPACING_M = 1000;

const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/** Round a position to 3 decimals: about 111 m north–south, less east–west ("about 100 m"). */
export function roundCell(lat: number, lon: number): Cell {
  const rl = round3(lat);
  const ro = round3(lon);
  return { key: `${rl.toFixed(3)},${ro.toFixed(3)}`, lat: rl, lon: ro };
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Scientific names in a set of sightings, most sightings first, then the most recent. */
export function speciesOrder<S extends Locatable>(sightings: S[]): string[] {
  const m = new Map<string, { n: number; last: number }>();
  for (const s of sightings) {
    const v = m.get(s.scientific) ?? { n: 0, last: 0 };
    v.n++;
    v.last = Math.max(v.last, s.lastTime);
    m.set(s.scientific, v);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)
    .map(([k]) => k);
}

const located = <S extends Locatable>(s: S): s is S & { lat: number; lon: number } => s.lat != null && s.lon != null && Number.isFinite(s.lat) && Number.isFinite(s.lon);

/**
 * Group located sightings into non-overlapping areas of 1 km diameter (see the file comment).
 * Sightings without a position are left out. Areas are ordered by number of sightings, then by
 * the most recent sighting.
 */
export function groupIntoAreas<S extends Locatable>(sightings: S[]): Area<S>[] {
  // Oldest first; the sort is stable, so equal times keep their input order.
  const ordered = sightings.filter(located).sort((a, b) => a.firstTime - b.firstTime);
  const areas: Array<{ lat: number; lon: number; sightings: S[] }> = [];
  for (const s of ordered) {
    let best: (typeof areas)[number] | null = null;
    let bestD = Infinity;
    for (const a of areas) {
      const d = haversine(s.lat, s.lon, a.lat, a.lon);
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    // Within 500 m: inside the nearest area. 500 m–1 km: the edge rule, still the nearest area.
    if (best && bestD < AREA_SPACING_M) best.sightings.push(s);
    else areas.push({ lat: s.lat, lon: s.lon, sightings: [s] });
  }
  return areas
    .map((a) => {
      const cell = roundCell(a.lat, a.lon);
      const newestFirst = [...a.sightings].sort((x, y) => y.lastTime - x.lastTime);
      return { key: cell.key, lat: a.lat, lon: a.lon, cell, sightings: newestFirst, species: speciesOrder(a.sightings) };
    })
    .sort((a, b) => b.sightings.length - a.sightings.length || b.sightings[0].lastTime - a.sightings[0].lastTime);
}
