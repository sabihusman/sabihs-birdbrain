/**
 * Looks up nature places near your sightings on OpenStreetMap's Overpass API and keeps the
 * answers on the phone (DECISIONS.md #72). Called only when the Map tab's Places view is open.
 *
 * - What is sent: the sightings' positions rounded to 3 decimals (about 100 m), deduplicated,
 *   inside a query that asks only for parks, reserves, botanical gardens, woods and trails.
 *   Nothing else: no species, no times, no account.
 * - Cache: one entry per rounded cell in the `wiki` store, key `places:<lat>,<lon>`, fresh for
 *   30 days. An older entry is still shown when a refresh fails or the phone is offline.
 * - Fair use (wiki.openstreetmap.org/wiki/Overpass_API): one request at a time, at most
 *   CELLS_PER_QUERY cells per request, a 15 s timeout, and after a 429 no request for 30 s.
 */
import { getWikiCache, putWikiCache } from '../storage/db';
import type { WikiCacheEntry } from '../storage/types';
import { buildOverpassQuery, cellsFor, CELLS_PER_QUERY, parseOverpass, QUERY_TIMEOUT_S, roundCell, type Cell, type NaturePlace } from './places';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const PLACES_CACHE_PREFIX = 'places:';
export const PLACES_TTL_MS = 30 * 24 * 3600 * 1000;
/** "If you receive an HTTP error code such as 429 or 406, pause for 30 seconds before making a new request." */
export const BUSY_PAUSE_MS = 30_000;

export type LookupStatus = 'ok' | 'busy' | 'offline';

export interface PlaceCache {
  get(key: string): Promise<WikiCacheEntry | undefined>;
  put(entry: WikiCacheEntry): Promise<void>;
}

export interface LookupDeps {
  fetch?: typeof fetch;
  cache?: PlaceCache;
  now?: () => number;
  online?: () => boolean;
  timeoutMs?: number;
}

export interface LookupResult {
  /** Places near each cell, for every cell with data (fresh or kept from before). */
  byCell: Map<string, NaturePlace[]>;
  /** Overall outcome: busy or offline when any cell could not be refreshed. */
  status: LookupStatus;
}

const defaultCache: PlaceCache = {
  get: (key) => getWikiCache(key),
  put: (entry) => putWikiCache(entry),
};

export const placesCacheKey = (cell: Cell) => `${PLACES_CACHE_PREFIX}${cell.key}`;

/** True when a cache entry is younger than 30 days. */
export function isFresh(entry: WikiCacheEntry | undefined, now: number): boolean {
  return !!entry && now - entry.fetchedAt < PLACES_TTL_MS && now >= entry.fetchedAt;
}

function cachedPlaces(entry: WikiCacheEntry | undefined): NaturePlace[] | undefined {
  const data = entry?.data as { places?: NaturePlace[] } | undefined;
  return Array.isArray(data?.places) ? data!.places : undefined;
}

let busyUntil = 0;
let chain: Promise<unknown> = Promise.resolve();

/** For tests: forget the 30 s pause after a 429. */
export function resetPlaceLookupState(): void {
  busyUntil = 0;
  chain = Promise.resolve();
}

async function fetchBatch(cells: Cell[], deps: Required<Pick<LookupDeps, 'fetch' | 'timeoutMs'>>): Promise<Map<string, NaturePlace[]> | 'busy' | 'offline'> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
  try {
    const res = await deps.fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(buildOverpassQuery(cells))}`,
      signal: ctrl.signal,
      credentials: 'omit',
    });
    if (!res.ok) return 'busy';
    return parseOverpass(await res.json(), cells);
  } catch (err) {
    // A timeout is the server being slow; anything else (no network, DNS) is being offline.
    return ctrl.signal.aborted ? 'busy' : (err as Error)?.name === 'AbortError' ? 'busy' : 'offline';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Places near each located point. Fresh cache entries are used as they are; missing or older
 * ones are fetched (one request at a time). Never throws.
 */
export function lookupPlaces(points: Array<{ lat: number | null; lon: number | null }>, deps: LookupDeps = {}): Promise<LookupResult> {
  const run = chain.then(() => doLookup(points, deps));
  chain = run.catch(() => undefined);
  return run;
}

async function doLookup(points: Array<{ lat: number | null; lon: number | null }>, deps: LookupDeps): Promise<LookupResult> {
  const now = deps.now ?? Date.now;
  const cache = deps.cache ?? defaultCache;
  const online = deps.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = deps.timeoutMs ?? QUERY_TIMEOUT_S * 1000;

  const cells = cellsFor(points);
  const byCell = new Map<string, NaturePlace[]>();
  const toFetch: Cell[] = [];
  for (const c of cells) {
    const entry = await cache.get(placesCacheKey(c)).catch(() => undefined);
    const places = cachedPlaces(entry);
    if (places) byCell.set(c.key, places);
    if (!places || !isFresh(entry, now())) toFetch.push(c);
  }
  if (toFetch.length === 0) return { byCell, status: 'ok' };
  if (!online()) return { byCell, status: 'offline' };
  if (now() < busyUntil) return { byCell, status: 'busy' };

  for (let i = 0; i < toFetch.length; i += CELLS_PER_QUERY) {
    const batch = toFetch.slice(i, i + CELLS_PER_QUERY);
    const result = await fetchBatch(batch, { fetch: doFetch, timeoutMs });
    if (result === 'busy' || result === 'offline') {
      if (result === 'busy') busyUntil = now() + BUSY_PAUSE_MS;
      return { byCell, status: result };
    }
    const fetchedAt = now();
    for (const c of batch) {
      const places = result.get(c.key) ?? [];
      byCell.set(c.key, places);
      await cache.put({ key: placesCacheKey(c), fetchedAt, data: { places } }).catch(() => undefined);
    }
  }
  return { byCell, status: 'ok' };
}

/** The candidate places for a sighting, from a lookup result (undefined when its cell is unknown). */
export function placesForPoint(byCell: Map<string, NaturePlace[]>, lat: number, lon: number): NaturePlace[] | undefined {
  return byCell.get(roundCell(lat, lon).key);
}
