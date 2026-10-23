/**
 * Names for the Map tab's areas, from OpenStreetMap's Nominatim reverse geocoder (DECISIONS.md #73).
 * Called only while the Places view is open.
 *
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * - "an absolute maximum of 1 request per second": one request at a time, at least
 *   MIN_INTERVAL_MS (1.1 s) between two requests from this page;
 * - "Results must be cached on your side": every answer, including "no name here", is kept in the
 *   `wiki` IndexedDB store under `geocode:<lat>,<lon>` for GEOCODE_TTL_MS (180 days);
 * - "a valid HTTP Referer or User-Agent identifying the application": the browser sends the site's
 *   Referer (origin only, from the Referrer-Policy); no forbidden header is set;
 * - "Apps must make sure that they can switch the service at our request at any time": the base URL
 *   is GEOCODER_URL, set by VITE_GEOCODER_URL at build time (plus the CSP connect-src).
 *
 * What is sent: the area's centre rounded to 3 decimals (about 100 m). Nothing else.
 */
import { getWikiCache, putWikiCache } from '../storage/db';
import type { WikiCacheEntry } from '../storage/types';
import type { Cell } from './areas';

export const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org';
/** The geocoder's base URL; one setting switches the service (VITE_GEOCODER_URL). */
export const GEOCODER_URL = ((import.meta.env?.VITE_GEOCODER_URL as string | undefined)?.trim() || DEFAULT_GEOCODER_URL).replace(/\/+$/, '');
export const GEOCODE_CACHE_PREFIX = 'geocode:';
/** Place names rarely change; an answer is reused for 180 days, then asked again. */
export const GEOCODE_TTL_MS = 180 * 24 * 3600 * 1000;
/** At least this long between two requests (the policy's maximum is 1 per second). */
export const MIN_INTERVAL_MS = 1100;
export const GEOCODE_TIMEOUT_MS = 10_000;

export interface PlaceLabel {
  /** "Jester Park", "Merle Hay Road", "Beaverdale" */
  name: string;
  /** "Johnston, Iowa"; empty when unknown. */
  line2: string;
}

export type GeocodeResult = { status: 'ok'; label: PlaceLabel | null } | { status: 'busy' } | { status: 'offline' } | { status: 'cancelled' };

/** The reverse request for a rounded centre: zoom 17 (major and minor streets, parks, buildings). */
export function reverseUrl(cell: Cell, base = GEOCODER_URL): string {
  return `${base}/reverse?format=jsonv2&lat=${cell.lat.toFixed(3)}&lon=${cell.lon.toFixed(3)}&zoom=17&addressdetails=1`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * The card's two lines from a Nominatim jsonv2 answer. Title: the feature's `name` (a park, a
 * building, a road), else the road, else the subdivision, neighbourhood, suburb, village, town,
 * city, township or county. Second line:
 * the town or city and the state, without repeating the title. Null when there is no name at all
 * (for example `{"error":"Unable to geocode"}` out at sea).
 */
export function placeLabel(json: unknown): PlaceLabel | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { name?: unknown; address?: Record<string, unknown> };
  const a = (j.address && typeof j.address === 'object' ? j.address : {}) as Record<string, unknown>;
  const locality = str(a.town) ?? str(a.city) ?? str(a.village) ?? str(a.hamlet) ?? str(a.municipality) ?? str(a.county);
  // `residential` (a subdivision's name) is what a point between roads can return, e.g. "Jester Glen Estates".
  const name = str(j.name) ?? str(a.road) ?? str(a.residential) ?? str(a.neighbourhood) ?? str(a.suburb) ?? str(a.quarter) ?? str(a.village) ?? str(a.hamlet) ?? str(a.town) ?? str(a.city) ?? str(a.municipality) ?? str(a.county);
  if (!name) return null;
  const region = str(a.state) ?? str(a.country);
  const line2 = [locality, region].filter((p, i, all): p is string => !!p && p !== name && all.indexOf(p) === i).join(', ');
  return { name, line2 };
}

/** "Near 41.672, −93.698" (a real minus sign), the title until a name is known. */
export function formatNear(cell: Cell): string {
  const f = (v: number) => (v < 0 ? `−${Math.abs(v).toFixed(3)}` : v.toFixed(3));
  return `Near ${f(cell.lat)}, ${f(cell.lon)}`;
}

export const geocodeCacheKey = (cell: Cell) => `${GEOCODE_CACHE_PREFIX}${cell.key}`;

export interface GeocodeCache {
  get(key: string): Promise<WikiCacheEntry | undefined>;
  put(entry: WikiCacheEntry): Promise<void>;
}

export interface GeocoderDeps {
  fetch?: typeof fetch;
  cache?: GeocodeCache;
  now?: () => number;
  online?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface CachedName {
  label: PlaceLabel | null;
  /** False after 180 days: still shown, and asked again. */
  fresh: boolean;
}

export interface Geocoder {
  /** The cached name for a centre, without any request. */
  cached(cell: Cell): Promise<CachedName | undefined>;
  /**
   * Fresh cache first; otherwise one request in the shared queue. `wanted` is checked just before
   * the request is sent, so nothing is sent once the Places view has closed. Never throws.
   */
  lookup(cell: Cell, wanted?: () => boolean): Promise<GeocodeResult>;
}

/** Busy unless the phone says it is offline: a failed request while online is the server's problem. */
export function failureStatus(online: boolean): 'busy' | 'offline' {
  return online ? 'busy' : 'offline';
}

const defaultCache: GeocodeCache = { get: (k) => getWikiCache(k), put: (e) => putWikiCache(e) };
const defaultOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export function createGeocoder(deps: GeocoderDeps = {}): Geocoder {
  const cache = deps.cache ?? defaultCache;
  const now = deps.now ?? (() => Date.now());
  const online = deps.online ?? defaultOnline;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = deps.timeoutMs ?? GEOCODE_TIMEOUT_MS;
  const baseUrl = deps.baseUrl ?? GEOCODER_URL;
  let lastSent = -Infinity;
  let chain: Promise<unknown> = Promise.resolve();

  const cached = async (cell: Cell): Promise<CachedName | undefined> => {
    const entry = await cache.get(geocodeCacheKey(cell)).catch(() => undefined);
    const data = entry?.data as { label?: PlaceLabel | null } | undefined;
    if (!entry || !data || !('label' in data)) return undefined;
    const age = now() - entry.fetchedAt;
    return { label: data.label ?? null, fresh: age >= 0 && age < GEOCODE_TTL_MS };
  };

  const request = async (cell: Cell, wanted: () => boolean): Promise<GeocodeResult> => {
    // Another caller may have filled the cache while this one waited in the queue.
    const hit = await cached(cell);
    if (hit?.fresh) return { status: 'ok', label: hit.label };
    if (!wanted()) return { status: 'cancelled' };
    if (!online()) return { status: 'offline' };
    const wait = lastSent + MIN_INTERVAL_MS - now();
    if (wait > 0) await sleep(wait);
    if (!wanted()) return { status: 'cancelled' };
    lastSent = now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(reverseUrl(cell, baseUrl), { signal: ctrl.signal, credentials: 'omit' });
      // 429, 5xx and any other non-OK answer: busy (never cached).
      if (!res.ok) return { status: failureStatus(online()) };
      const label = placeLabel(await res.json());
      await cache.put({ key: geocodeCacheKey(cell), fetchedAt: now(), data: { label } }).catch(() => undefined);
      return { status: 'ok', label };
    } catch {
      // A network TypeError, the 10 s timeout or a broken body.
      return { status: failureStatus(online()) };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    cached,
    async lookup(cell, wanted = () => true) {
      const hit = await cached(cell);
      if (hit?.fresh) return { status: 'ok', label: hit.label };
      const run = chain.then(() => request(cell, wanted));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** The page's one geocoder, so the 1.1 s spacing holds across views. */
export const geocoder = createGeocoder();
