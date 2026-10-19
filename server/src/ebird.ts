/**
 * eBird recent sightings for the AI context: the most recent report of the
 * species per location in the app's state/province and, for nearby questions,
 * within 50 km of the app's position rounded to 0.1°. Needs EBIRD_API_KEY;
 * without it the source is skipped.
 *
 * Endpoints (eBird API 2.0, verified against the Postman documentation at
 * https://documenter.getpostman.com/view/664302/S1ENwy59 on 2026-10-19; the
 * collection JSON behind it lists the base URL https://api.ebird.org/v2):
 *   GET /v2/ref/taxonomy/ebird?fmt=json&cat=species
 *       rows of { sciName, comName, speciesCode, category, … }; the `species`
 *       filter takes species codes, not names, so the whole taxonomy is
 *       downloaded once and cached 30 days to map scientific name → code.
 *   GET /v2/data/obs/{regionCode}/recent/{speciesCode}?back=30
 *       regionCode is a country, subnational1 ("US-IA") or subnational2 code;
 *       back 1–30 (default 14). Most recent observation per location.
 *   GET /v2/data/obs/geo/recent/{speciesCode}?lat=&lng=&back=30&dist=50
 *       lat/lng to 2 decimals, dist 0–50 km (default 25).
 *   Header X-eBirdApiToken (the docs spell it x-ebirdapitoken; header names
 *   are case-insensitive). Observation rows: { speciesCode, comName, sciName,
 *   locId, locName, obsDt, howMany, lat, lng, obsValid, obsReviewed,
 *   locationPrivate, subId }. Only locName, obsDt and howMany are kept, and
 *   coordinates embedded in locality names are removed.
 */
import type { DatabaseSync } from 'node:sqlite';
import { cleanField } from './natureserve.js';
import { describeRegion, type RegionCode } from './regions.js';

const API = 'https://api.ebird.org/v2';
export const EBIRD_SITE = 'https://ebird.org';
export const EBIRD_DAYS_BACK = 30;
export const EBIRD_NEARBY_KM = 50;
export const EBIRD_TIMEOUT_MS = 8000;
export const EBIRD_OBS_CACHE_TTL_MS = 60 * 60 * 1000;
export const EBIRD_TAXONOMY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows kept per query (most recent first); eBird text is untrusted model input and stays bounded. */
export const MAX_OBSERVATIONS = 15;

/** One sighting as the prompt sees it: no observer, no coordinates, no checklist id. */
export interface EbirdObservation {
  locality: string;
  date: string;
  count: number | null;
}

/** The three HTTP calls, injectable for tests. */
export interface EbirdApi {
  /** Lowercased scientific name → eBird species code, whole taxonomy. */
  taxonomy(): Promise<Record<string, string>>;
  recentInRegion(speciesCode: string, region: RegionCode): Promise<EbirdObservation[]>;
  recentNearby(speciesCode: string, lat: number, lon: number): Promise<EbirdObservation[]>;
}

/** What the ask pipeline uses: the cached API plus the name → code step. */
export interface EbirdSource {
  speciesCode(scientific: string, now?: number): Promise<string | null>;
  recentInRegion(speciesCode: string, region: RegionCode, now?: number): Promise<EbirdObservation[]>;
  recentNearby(speciesCode: string, lat: number, lon: number, now?: number): Promise<EbirdObservation[]>;
}

interface TaxonomyRow {
  sciName?: string;
  speciesCode?: string;
  category?: string;
}

interface ObservationRow {
  locName?: string;
  obsDt?: string;
  howMany?: unknown;
  locationPrivate?: unknown;
}

/** "Park (42.8366,-75.0028)" → "Park": eBird puts coordinates into auto-named localities. */
export function stripCoordinates(locality: string): string {
  return locality
    .replace(/\(?\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*\)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pure: taxonomy rows → name map (species rows only). */
export function taxonomyMap(rows: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows as TaxonomyRow[]) {
    if (typeof r?.sciName !== 'string' || typeof r.speciesCode !== 'string') continue;
    if (r.category && r.category !== 'species') continue;
    const code = r.speciesCode.trim();
    if (/^[a-z0-9]{3,12}$/.test(code)) out[r.sciName.trim().toLowerCase()] = code;
  }
  return out;
}

/** Pure: observation rows → bounded, observer-free, coordinate-free list, most recent first. */
export function normalizeObservations(rows: unknown): EbirdObservation[] {
  if (!Array.isArray(rows)) return [];
  const out: EbirdObservation[] = [];
  for (const r of rows as ObservationRow[]) {
    if (!r || typeof r !== 'object') continue;
    const raw = cleanField(r.obsDt);
    const date = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(raw) ? raw.slice(0, 10) : 'unknown date';
    const locality = r.locationPrivate === true ? 'a private location' : stripCoordinates(cleanField(r.locName)) || 'an unnamed location';
    const count = typeof r.howMany === 'number' && Number.isInteger(r.howMany) && r.howMany >= 0 ? r.howMany : null;
    out.push({ locality, date, count });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.slice(0, MAX_OBSERVATIONS);
}

export function createEbirdApi(apiKey: string): EbirdApi {
  const headers = { Accept: 'application/json', 'X-eBirdApiToken': apiKey };
  const getJson = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const url = `${API}${path}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(EBIRD_TIMEOUT_MS) });
    // The status only; the URL would not leak the key (it is a header) but is not logged either.
    if (!res.ok) throw new Error(`eBird responded ${res.status}`);
    return res.json();
  };
  return {
    taxonomy: async () => taxonomyMap(await getJson('/ref/taxonomy/ebird', { fmt: 'json', cat: 'species' })),
    recentInRegion: async (code, region) => normalizeObservations(await getJson(`/data/obs/${encodeURIComponent(region)}/recent/${encodeURIComponent(code)}`, { back: String(EBIRD_DAYS_BACK) })),
    recentNearby: async (code, lat, lon) => normalizeObservations(await getJson(`/data/obs/geo/recent/${encodeURIComponent(code)}`, { lat: lat.toFixed(2), lng: lon.toFixed(2), back: String(EBIRD_DAYS_BACK), dist: String(EBIRD_NEARBY_KM) })),
  };
}

/** SQLite cache in front of an EbirdApi: taxonomy 30 days, observations one hour per species+region or species+point. */
export function createEbirdSource(db: DatabaseSync, api: EbirdApi, ttl: { obsMs?: number; taxonomyMs?: number } = {}): EbirdSource {
  const obsTtl = ttl.obsMs ?? EBIRD_OBS_CACHE_TTL_MS;
  const taxTtl = ttl.taxonomyMs ?? EBIRD_TAXONOMY_CACHE_TTL_MS;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ebird_cache (
      key TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const get = db.prepare('SELECT fetched_at, payload FROM ebird_cache WHERE key = ?');
  const put = db.prepare('INSERT INTO ebird_cache (key, fetched_at, payload) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload');
  const cached = async <T>(key: string, ttlMs: number, now: number, load: () => Promise<T>): Promise<T> => {
    const row = get.get(key) as { fetched_at: number; payload: string } | undefined;
    if (row && now - Number(row.fetched_at) < ttlMs) {
      try {
        return JSON.parse(row.payload) as T;
      } catch {
        // fall through to a fresh fetch
      }
    }
    const value = await load();
    put.run(key, now, JSON.stringify(value));
    return value;
  };
  return {
    speciesCode: async (scientific, now = Date.now()) => {
      const map = await cached('taxonomy', taxTtl, now, () => api.taxonomy());
      return map[scientific.trim().toLowerCase()] ?? null;
    },
    recentInRegion: (code, region, now = Date.now()) => cached(`region:${region}:${code}`, obsTtl, now, () => api.recentInRegion(code, region)),
    recentNearby: (code, lat, lon, now = Date.now()) => cached(`near:${code}:${lat.toFixed(1)}:${lon.toFixed(1)}`, obsTtl, now, () => api.recentNearby(code, lat, lon)),
  };
}

export type EbirdScope = { kind: 'region'; region: RegionCode } | { kind: 'near' };

function scopeText(scope: EbirdScope): string {
  return scope.kind === 'region' ? `in ${describeRegion(scope.region)}` : `within ${EBIRD_NEARBY_KM} km of the asker's approximate position (rounded to about 10 km)`;
}

/** The text of an eBird section in the prompt (fence-neutralised later with every other section). */
export function ebirdText(obs: EbirdObservation[], scope: EbirdScope): string {
  const where = scopeText(scope);
  if (obs.length === 0) return `eBird lists no reports of this species ${where} in the last ${EBIRD_DAYS_BACK} days.`;
  const lines = obs.map((o) => `${o.date}: ${o.locality}${o.count == null ? ' (count not given)' : `, ${o.count} bird${o.count === 1 ? '' : 's'}`}`);
  return [`Reports of this species to eBird ${where} in the last ${EBIRD_DAYS_BACK} days (most recent report per location, newest first, up to ${MAX_OBSERVATIONS} shown; date: location, count):`, ...lines].join('\n');
}

/** Public eBird page for the species, for the sources list. */
export function ebirdSpeciesUrl(speciesCode: string | null): string {
  return speciesCode ? `${EBIRD_SITE}/species/${encodeURIComponent(speciesCode)}` : EBIRD_SITE;
}
