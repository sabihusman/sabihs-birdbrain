/**
 * NatureServe Explorer conservation status for the AI context: the global
 * rank (G-rank) and the subnational rank (S-rank) for the state/province the
 * app named. No API key is needed.
 *
 * Endpoint (verified against https://explorer.natureserve.org/api-docs/ on
 * 2026-10-19, "Species Search"):
 *   POST https://explorer.natureserve.org/api/data/speciesSearch
 *   { "criteriaType": "species",
 *     "textCriteria": [{ "paramType": "textSearch", "searchToken": "<scientific name>",
 *                        "matchAgainst": "scientificName", "operator": "equals" }],
 *     "pagingOptions": { "page": 0, "recordsPerPage": 5 } }
 * Each entry of `results` carries `scientificName`, `primaryCommonName`,
 * `roundedGRank`, `nsxUrl` (relative) and `nations[]` with `nationCode` and
 * `subnations[]` of `{ subnationCode, roundedSRank, exotic, native }`, so one
 * call gives every S-rank; the taxon endpoints (`GET /api/data/taxon/{uid}`)
 * return the same ranks as `elementNationals[].elementSubnationals[]` and are
 * not needed. The response is cached per species (30 days) and the region's
 * rank is picked out of the cached record at prompt time.
 */
import type { DatabaseSync } from 'node:sqlite';
import { describeRegion, type Region } from './regions.js';

const API = 'https://explorer.natureserve.org/api/data/speciesSearch';
const SITE = 'https://explorer.natureserve.org';
const USER_AGENT = 'SabihsBirdbrainAPI/1.0 (https://github.com/sabihusman/sabihs-birdbrain)';
export const NATURESERVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NATURESERVE_TIMEOUT_MS = 8000;
/** Any single fetched string is bounded before it can reach the prompt. */
const MAX_FIELD_CHARS = 120;

export interface NatureServeStatus {
  scientific: string;
  common: string;
  /** Rounded global rank, e.g. "G5". */
  globalRank: string;
  /** Link to the record on explorer.natureserve.org. */
  url: string;
  /** Rounded subnational ranks keyed by "US-IA" style codes. */
  subnational: Record<string, string>;
  fetchedAt: number;
}

export type NatureServeFetcher = (scientific: string, now?: number) => Promise<NatureServeStatus | null>;

interface SearchResponse {
  results?: Array<{
    scientificName?: string;
    primaryCommonName?: string;
    roundedGRank?: string | null;
    nsxUrl?: string;
    nations?: Array<{ nationCode?: string; subnations?: Array<{ subnationCode?: string; roundedSRank?: string | null }> }>;
  }>;
}

/**
 * Bound a fetched string, drop control characters and square brackets (so a
 * field cannot pose as a "[Section: …]" label or a citation); the fence tags
 * are neutralised later, at prompt time, with every other section.
 */
export function cleanField(s: unknown): string {
  if (typeof s !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_CHARS);
}

/** Only a relative Explorer path is accepted for the link; anything else falls back to the site root. */
export function recordUrl(nsxUrl: unknown): string {
  if (typeof nsxUrl === 'string' && /^\/Taxon\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(nsxUrl)) return `${SITE}${nsxUrl}`;
  return SITE;
}

/** Pure: the status record from a speciesSearch response (the fetcher and tests share it). */
export function statusFromSearch(scientific: string, data: SearchResponse, now = Date.now()): NatureServeStatus | null {
  const results = Array.isArray(data.results) ? data.results : [];
  const hit = results.find((r) => typeof r.scientificName === 'string' && r.scientificName.trim().toLowerCase() === scientific.trim().toLowerCase());
  if (!hit) return null;
  const subnational: Record<string, string> = {};
  for (const nation of hit.nations ?? []) {
    const nationCode = cleanField(nation.nationCode).toUpperCase();
    if (!/^[A-Z]{2}$/.test(nationCode)) continue;
    for (const s of nation.subnations ?? []) {
      const sub = cleanField(s.subnationCode).toUpperCase();
      const rank = cleanField(s.roundedSRank);
      if (/^[A-Z]{2}$/.test(sub) && rank) subnational[`${nationCode}-${sub}`] = rank;
    }
  }
  return { scientific: cleanField(hit.scientificName), common: cleanField(hit.primaryCommonName), globalRank: cleanField(hit.roundedGRank) || 'not ranked', url: recordUrl(hit.nsxUrl), subnational, fetchedAt: now };
}

export const fetchNatureServeStatus: NatureServeFetcher = async (scientific, now = Date.now()) => {
  const body = {
    criteriaType: 'species',
    textCriteria: [{ paramType: 'textSearch', searchToken: scientific, matchAgainst: 'scientificName', operator: 'equals' }],
    pagingOptions: { page: 0, recordsPerPage: 5 },
  };
  const res = await fetch(API, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify(body), signal: AbortSignal.timeout(NATURESERVE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`NatureServe responded ${res.status}`);
  return statusFromSearch(scientific, (await res.json()) as SearchResponse, now);
};

/** SQLite cache in front of a NatureServeFetcher: one row per species, valid for NATURESERVE_CACHE_TTL_MS. */
export function createNatureServeCache(db: DatabaseSync, ttlMs = NATURESERVE_CACHE_TTL_MS) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS natureserve_cache (
      key TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const get = db.prepare('SELECT fetched_at, payload FROM natureserve_cache WHERE key = ?');
  const put = db.prepare('INSERT INTO natureserve_cache (key, fetched_at, payload) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload');
  const del = db.prepare('DELETE FROM natureserve_cache WHERE key = ?');
  return {
    wrap(fetcher: NatureServeFetcher): NatureServeFetcher {
      return async (scientific, now = Date.now()) => {
        const row = get.get(scientific) as { fetched_at: number; payload: string } | undefined;
        if (row && now - Number(row.fetched_at) < ttlMs) {
          try {
            return JSON.parse(row.payload) as NatureServeStatus | null;
          } catch {
            del.run(scientific);
          }
        }
        const status = await fetcher(scientific, now);
        // A miss is cached too: a species NatureServe does not list stays unlisted for a month.
        put.run(scientific, now, JSON.stringify(status));
        return status;
      };
    },
  };
}

const RANK_WORDS: Record<string, string> = {
  '1': 'critically imperiled',
  '2': 'imperiled',
  '3': 'vulnerable',
  '4': 'apparently secure',
  '5': 'secure',
  H: 'possibly extirpated',
  X: 'presumed extirpated',
  U: 'unrankable',
  NR: 'not ranked',
  NA: 'not applicable',
};

/** "S5B,S3N" → "S5B (secure, breeding population), S3N (vulnerable, non-breeding population)". Unknown codes stay as they are. */
export function describeRank(rank: string): string {
  return rank
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((code) => {
      const m = /^[GNST]([1-5]|H|X|U|NR|NA)(B|N|M)?\??$/i.exec(code);
      if (!m) return code;
      const words = [RANK_WORDS[m[1].toUpperCase()]];
      if (m[2]) words.push({ B: 'breeding population', N: 'non-breeding population', M: 'migrant population' }[m[2].toUpperCase()]!);
      return `${code} (${words.join(', ')})`;
    })
    .join(', ');
}

/** The text of the NatureServe section in the prompt (fence-neutralised later with every other section). */
export function natureServeText(status: NatureServeStatus, region: Region): string {
  const lines = [`NatureServe global conservation status rank for ${status.common || status.scientific}: ${describeRank(status.globalRank)}.`];
  if (region === 'none') {
    lines.push('No state or province was given with the question, so no state/province (S) rank is included.');
  } else {
    const rank = status.subnational[region];
    lines.push(rank ? `NatureServe state/province rank in ${describeRegion(region)}: ${describeRank(rank)}.` : `NatureServe lists no state/province rank for this species in ${describeRegion(region)}.`);
  }
  return lines.join('\n');
}
