/**
 * "Pick a place" on Species when there is no location (DECISIONS.md #105): a town name, searched with
 * OpenStreetMap's Nominatim, becomes the manual location.
 *
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/): no search-as-you-type ("you must
 * not implement such a service on the client side"), so a search runs only when the person presses Search;
 * at most one request per MIN_INTERVAL_MS; answers are cached in the `wiki` store under `geosearch:` for
 * GEOCODE_TTL_MS. What is sent: the typed name, nothing else. The base URL is the same switchable GEOCODER_URL.
 */
import { getWikiCache, putWikiCache } from '../storage/db';
import { GEOCODE_TIMEOUT_MS, GEOCODE_TTL_MS, GEOCODER_URL, MIN_INTERVAL_MS } from './geocode';

export interface PlaceMatch {
  /** "Ithaca" */
  name: string;
  /** "New York, United States" */
  line2: string;
  lat: number;
  lon: number;
}

export type PlaceSearchResult = { status: 'ok'; places: PlaceMatch[] } | { status: 'busy' } | { status: 'offline' } | { status: 'too-short' };

export const PLACE_SEARCH_LIMIT = 5;
export const PLACE_SEARCH_PREFIX = 'geosearch:';

export function placeSearchUrl(query: string, base = GEOCODER_URL): string {
  return `${base}/search?format=jsonv2&addressdetails=1&limit=${PLACE_SEARCH_LIMIT}&q=${encodeURIComponent(query.trim())}`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Matches from a Nominatim jsonv2 search answer; anything without a name or a position is left out. */
export function parsePlaces(json: unknown): PlaceMatch[] {
  if (!Array.isArray(json)) return [];
  const out: PlaceMatch[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const j = item as { name?: unknown; lat?: unknown; lon?: unknown; address?: Record<string, unknown> };
    const lat = Number(j.lat);
    const lon = Number(j.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const a = (j.address && typeof j.address === 'object' ? j.address : {}) as Record<string, unknown>;
    const name = str(j.name) ?? str(a.city) ?? str(a.town) ?? str(a.village) ?? str(a.county) ?? str(a.state);
    if (!name) continue;
    const line2 = [str(a.state) ?? str(a.county), str(a.country)].filter((p, i, all): p is string => !!p && p !== name && all.indexOf(p) === i).join(', ');
    out.push({ name, line2, lat, lon });
  }
  return out;
}

export interface PlaceSearchDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  online?: () => boolean;
  cache?: { get: typeof getWikiCache; put: typeof putWikiCache };
  baseUrl?: string;
}

export function createPlaceSearch(deps: PlaceSearchDeps = {}): (query: string) => Promise<PlaceSearchResult> {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const online = deps.online ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const cache = deps.cache ?? { get: getWikiCache, put: putWikiCache };
  const baseUrl = deps.baseUrl ?? GEOCODER_URL;
  let lastSent = -Infinity;
  return async (query) => {
    const q = query.trim().replace(/\s+/g, ' ');
    if (q.length < 2) return { status: 'too-short' };
    const key = `${PLACE_SEARCH_PREFIX}${q.toLowerCase()}`;
    const hit = await cache.get(key).catch(() => undefined);
    if (hit && now() - hit.fetchedAt < GEOCODE_TTL_MS) return { status: 'ok', places: (hit.data as { places: PlaceMatch[] }).places ?? [] };
    if (!online()) return { status: 'offline' };
    const wait = lastSent + MIN_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    lastSent = now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEOCODE_TIMEOUT_MS);
    try {
      const res = await doFetch(placeSearchUrl(q, baseUrl), { signal: ctrl.signal, credentials: 'omit' });
      if (!res.ok) return { status: online() ? 'busy' : 'offline' };
      const places = parsePlaces(await res.json());
      await cache.put({ key, fetchedAt: now(), data: { places } }).catch(() => undefined);
      return { status: 'ok', places };
    } catch {
      return { status: online() ? 'busy' : 'offline' };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The page's one place search, so the spacing holds however often Search is pressed. */
export const searchPlaces = createPlaceSearch();
