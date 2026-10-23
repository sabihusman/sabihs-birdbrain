/**
 * Nature places near your sightings, from OpenStreetMap through the Overpass API (DECISIONS.md #72).
 * Pure functions only: rounding, the query, parsing the answer, the tag rules and the grouping.
 * The network and the IndexedDB cache live in src/geo/place-lookup.ts.
 *
 * Only nature features are ever asked for: parks, nature reserves and protected areas, botanical
 * gardens, named woods and forests, and named trails. The query never names a shop, amenity,
 * tourism or any other key, and every element that comes back is checked again with
 * `classifyPlace()` before it is used.
 */

export type PlaceKind = 'park' | 'reserve' | 'garden' | 'wood' | 'trail';

export interface NaturePlace {
  /** "way/123", "relation/9", "node/42" (OSM ids are unique per type only). */
  id: string;
  name: string;
  kind: PlaceKind;
  /** Centre: the node itself, or the middle of the bounding box. */
  lat: number;
  lon: number;
  /** [south, west, north, east] for ways and relations; absent for a node. */
  bbox?: [number, number, number, number];
}

export interface Cell {
  /** "41.673,-93.698" */
  key: string;
  lat: number;
  lon: number;
}

/** A sighting belongs to a place within this distance (Sabih's choice 2a). */
export const PLACE_RADIUS_M = 500;
/** Cells per Overpass request; more cells go in further requests, one after the other. */
export const CELLS_PER_QUERY = 25;
/** Server-side run time limit asked for in the query, seconds (the client aborts at the same time). */
export const QUERY_TIMEOUT_S = 15;

const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Round a position to 3 decimals: about 111 m north–south, and less east–west away from the
 * equator ("about 100 m"). This is all that leaves the phone; the exact position never does.
 */
export function roundCell(lat: number, lon: number): Cell {
  const rl = round3(lat);
  const ro = round3(lon);
  return { key: `${rl.toFixed(3)},${ro.toFixed(3)}`, lat: rl, lon: ro };
}

/** One cell per distinct rounded position, in first-seen order. Points without a position are skipped. */
export function cellsFor(points: Array<{ lat: number | null; lon: number | null }>): Cell[] {
  const out = new Map<string, Cell>();
  for (const p of points) {
    if (p.lat == null || p.lon == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const c = roundCell(p.lat, p.lon);
    if (!out.has(c.key)) out.set(c.key, c);
  }
  return Array.from(out.values());
}

/**
 * The only tag filters ever sent. Each one also requires a name. `around` with one coordinate pair
 * is a circle around that point; with several pairs it would be a line through them, which is why
 * each cell gets its own statements.
 */
export const PLACE_FILTERS: readonly string[] = [
  'nwr{A}["leisure"~"^(park|nature_reserve)$"]["name"]',
  'nwr{A}["leisure"="garden"]["garden:type"="botanical"]["name"]',
  'nwr{A}["leisure"="garden"]["name"~"botanic|arboretum",i]',
  'nwr{A}["boundary"~"^(protected_area|national_park)$"]["name"]',
  'nwr{A}["landuse"="forest"]["name"]',
  'nwr{A}["natural"="wood"]["name"]',
  'way{A}["highway"~"^(path|footway|track)$"]["name"]',
  'rel{A}["route"~"^(hiking|foot)$"]["name"]',
];

/**
 * One Overpass QL request for a batch of cells. The answer lists, for each cell in order, an
 * `out count` marker followed by the ids found within 500 m of it, then one more marker and every
 * place once, with tags and a centre (nodes) or bounding box (ways, relations). No geometry is
 * downloaded, so the answer stays small even for a large forest.
 */
export function buildOverpassQuery(cells: Cell[], radiusM = PLACE_RADIUS_M): string {
  const lines = [`[out:json][timeout:${QUERY_TIMEOUT_S}];`];
  cells.forEach((c, i) => {
    const around = `(around:${radiusM},${c.lat.toFixed(3)},${c.lon.toFixed(3)})`;
    lines.push('(');
    for (const f of PLACE_FILTERS) lines.push(`  ${f.replace('{A}', around)};`);
    lines.push(`)->.c${i};`);
  });
  lines.push(`(${cells.map((_, i) => `.c${i};`).join(' ')})->.all;`);
  cells.forEach((_, i) => lines.push(`.c${i} out count;`, `.c${i} out ids;`));
  lines.push('.all out count;', 'node.all;', 'out;', 'way.all;', 'out tags bb;', 'rel.all;', 'out tags bb;');
  return lines.join('\n');
}

/** Which kind of nature place these tags describe, or null when it is not one we use. */
export function classifyPlace(tags: Record<string, string> | undefined): PlaceKind | null {
  if (!tags || !tags.name || !tags.name.trim()) return null;
  const { leisure, boundary, landuse, natural, highway, route } = tags;
  if (leisure === 'nature_reserve' || boundary === 'protected_area' || boundary === 'national_park') return 'reserve';
  if (leisure === 'park') return 'park';
  if (leisure === 'garden') return tags['garden:type'] === 'botanical' || /botanic|arboretum/i.test(tags.name) ? 'garden' : null;
  if (landuse === 'forest' || natural === 'wood') return 'wood';
  if (highway === 'path' || highway === 'footway' || highway === 'track') return 'trail';
  if (route === 'hiking' || route === 'foot') return 'trail';
  return null;
}

export const KIND_LABEL: Record<PlaceKind, string> = { park: 'Park', reserve: 'Nature reserve', garden: 'Botanical garden', wood: 'Woods', trail: 'Trail' };

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
}

function toPlace(e: OverpassElement): NaturePlace | null {
  const kind = classifyPlace(e.tags);
  if (!kind) return null;
  const id = `${e.type}/${e.id}`;
  const name = e.tags!.name.trim();
  if (e.bounds) {
    const b = e.bounds;
    const bbox: [number, number, number, number] = [b.minlat, b.minlon, b.maxlat, b.maxlon];
    if (!bbox.every(Number.isFinite)) return null;
    return { id, name, kind, lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2, bbox };
  }
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { id, name, kind, lat, lon };
}

/**
 * Split an answer to `buildOverpassQuery(cells)` into the places near each cell. When the count
 * markers are not where they should be, every place is offered to every cell and the 500 m check
 * on the phone (`groupByPlace`) does the sorting.
 */
export function parseOverpass(json: unknown, cells: Cell[]): Map<string, NaturePlace[]> {
  const elements = ((json as { elements?: OverpassElement[] } | null)?.elements ?? []).filter((e) => e && typeof e.type === 'string');
  const markers = elements.reduce<number[]>((acc, e, i) => (e.type === 'count' ? [...acc, i] : acc), []);
  const out = new Map<string, NaturePlace[]>();
  if (markers.length === cells.length + 1) {
    const full = elements.slice(markers[cells.length] + 1);
    const byId = new Map<string, NaturePlace>();
    for (const e of full) {
      const p = toPlace(e);
      if (p) byId.set(p.id, p);
    }
    cells.forEach((c, i) => {
      const ids = elements.slice(markers[i] + 1, markers[i + 1]).map((e) => `${e.type}/${e.id}`);
      out.set(c.key, Array.from(new Set(ids)).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
    });
    return out;
  }
  const all = new Map<string, NaturePlace>();
  for (const e of elements) {
    const p = toPlace(e);
    if (p) all.set(p.id, p);
  }
  for (const c of cells) out.set(c.key, Array.from(all.values()));
  return out;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Metres from a point to a place: to the node, or to the nearest edge of the place's bounding
 * box (0 when the point is inside the box). The box always contains the real shape, so this
 * never says a place is further than it is.
 */
export function distanceToPlace(lat: number, lon: number, p: NaturePlace): number {
  if (!p.bbox) return haversine(lat, lon, p.lat, p.lon);
  const [s, w, n, e] = p.bbox;
  return haversine(lat, lon, Math.min(n, Math.max(s, lat)), Math.min(e, Math.max(w, lon)));
}

function bboxArea(p: NaturePlace): number {
  if (!p.bbox) return 0;
  const [s, w, n, e] = p.bbox;
  return Math.abs(n - s) * Math.abs(e - w) * Math.cos(rad((n + s) / 2));
}

/** The nearest place within `maxMeters`; on a tie (inside two boxes) the smaller, more specific one. */
export function nearestPlace(lat: number, lon: number, places: NaturePlace[], maxMeters = PLACE_RADIUS_M): NaturePlace | null {
  let best: NaturePlace | null = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = distanceToPlace(lat, lon, p);
    if (d > maxMeters) continue;
    const closer = !best || d < bestD - 1;
    const tie = best && Math.abs(d - bestD) <= 1;
    const smaller = tie && (bboxArea(p) < bboxArea(best!) || (bboxArea(p) === bboxArea(best!) && p.name.localeCompare(best!.name) < 0));
    if (closer || smaller) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export interface Locatable {
  lat: number | null;
  lon: number | null;
  scientific: string;
  lastTime: number;
}

export interface PlaceGroup<S extends Locatable> {
  place: NaturePlace;
  sightings: S[];
  /** Scientific names, most sightings first. */
  species: string[];
}

export interface PlaceGrouping<S extends Locatable> {
  groups: PlaceGroup<S>[];
  /** Located, looked up, and not within `maxMeters` of a nature place. */
  other: S[];
  /** Located, but the places near them are not known yet (offline, busy). */
  unknown: S[];
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

/**
 * Group located sightings by their nearest nature place within `maxMeters`. `places` is either one
 * list for every sighting or a function giving the candidates for a sighting (the places Overpass
 * found around its rounded cell), returning undefined when that cell has not been looked up.
 * Groups are ordered by number of sightings, then name.
 */
export function groupByPlace<S extends Locatable>(sightings: S[], places: NaturePlace[] | ((s: S) => NaturePlace[] | undefined), maxMeters = PLACE_RADIUS_M): PlaceGrouping<S> {
  const byPlace = new Map<string, { place: NaturePlace; sightings: S[] }>();
  const other: S[] = [];
  const unknown: S[] = [];
  for (const s of sightings) {
    if (s.lat == null || s.lon == null) continue;
    const candidates = typeof places === 'function' ? places(s) : places;
    if (!candidates) {
      unknown.push(s);
      continue;
    }
    const p = nearestPlace(s.lat, s.lon, candidates, maxMeters);
    if (!p) {
      other.push(s);
      continue;
    }
    const g = byPlace.get(p.id) ?? { place: p, sightings: [] };
    g.sightings.push(s);
    byPlace.set(p.id, g);
  }
  const groups = Array.from(byPlace.values())
    .map((g) => ({ ...g, species: speciesOrder(g.sightings) }))
    .sort((a, b) => b.sightings.length - a.sightings.length || a.place.name.localeCompare(b.place.name));
  return { groups, other, unknown };
}
