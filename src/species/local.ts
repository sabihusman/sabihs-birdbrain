import type { Species } from '../model/labels';

/** Moving further than this from the cached position recomputes the local list. */
export const LOCAL_RECOMPUTE_KM = 25;
export const WEEKS_PER_YEAR = 48;
const STORAGE_KEY = 'birdbrain.localSpecies.v1';

/** The slice of Web Storage this module uses (structural, so the file also compiles for the worker). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  const g = globalThis as { localStorage?: StorageLike };
  try {
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Per-species maximum over the geo model's output for all 48 weeks.
 * `probs` is row-major [weeks][species]; the result has one value per species.
 */
export function maxOverWeeks(probs: ArrayLike<number>, weeks: number, speciesCount: number): Float32Array {
  const out = new Float32Array(speciesCount);
  for (let w = 0; w < weeks; w++) {
    const base = w * speciesCount;
    for (let i = 0; i < speciesCount; i++) {
      const p = probs[base + i];
      if (p > out[i]) out[i] = p;
    }
  }
  return out;
}

/** Species whose best week scores at or above the threshold. */
export function localIndices(maxProbs: ArrayLike<number>, threshold: number): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < maxProbs.length; i++) if (maxProbs[i] >= threshold) s.add(i);
  return s;
}

export interface LocalSpeciesEntry {
  lat: number;
  lon: number;
  /** Max probability over the 48 weeks, per species index. */
  maxProbs: Float32Array;
  computedAt: number;
}

/**
 * Cache of the geo model's year-round scores for one position. Recomputed
 * only when the device moves more than LOCAL_RECOMPUTE_KM; the threshold is
 * applied at read time, so changing it costs nothing.
 */
export class LocalSpeciesCache {
  private entry: LocalSpeciesEntry | null = null;

  constructor(private readonly storage: StorageLike | null = defaultStorage()) {
    this.entry = LocalSpeciesCache.load(storage);
  }

  static load(storage: StorageLike | null): LocalSpeciesEntry | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as { lat: number; lon: number; maxProbs: number[]; computedAt: number };
      if (typeof p.lat !== 'number' || typeof p.lon !== 'number' || !Array.isArray(p.maxProbs)) return null;
      return { lat: p.lat, lon: p.lon, maxProbs: Float32Array.from(p.maxProbs), computedAt: p.computedAt ?? 0 };
    } catch {
      return null;
    }
  }

  get current(): LocalSpeciesEntry | null {
    return this.entry;
  }

  /** True when there is no cached entry or the position moved more than LOCAL_RECOMPUTE_KM. */
  needsRecompute(lat: number, lon: number): boolean {
    if (!this.entry) return true;
    return haversineKm(this.entry.lat, this.entry.lon, lat, lon) > LOCAL_RECOMPUTE_KM;
  }

  set(entry: LocalSpeciesEntry): void {
    this.entry = entry;
    try {
      // Quantised to 3 decimals: ~6.5k floats stay well under 100 KB.
      this.storage?.setItem(STORAGE_KEY, JSON.stringify({ ...entry, maxProbs: Array.from(entry.maxProbs, (v) => Math.round(v * 1000) / 1000) }));
    } catch {
      /* storage full or unavailable */
    }
  }

  clear(): void {
    this.entry = null;
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}

export interface LocalFilterResult {
  /** The species to show. */
  shown: Species[];
  localCount: number | null;
  total: number;
  /** Why the whole list is shown, when it is. */
  note: string | null;
}

/**
 * Decide what the Species tab lists: local species by default, everything on
 * request or when no location (and therefore no local list) is available.
 */
export function filterLocal(all: Species[], local: Set<number> | null, showAll: boolean, locationNote: string | null): LocalFilterResult {
  const total = all.length;
  if (!local) return { shown: all, localCount: null, total, note: locationNote ?? 'All species: no location to narrow the list.' };
  const localList = all.filter((s) => local.has(s.index));
  if (showAll) return { shown: all, localCount: localList.length, total, note: null };
  return { shown: localList, localCount: localList.length, total, note: null };
}

export function describeLocalCount(r: LocalFilterResult): string {
  const fmt = (n: number) => n.toLocaleString();
  return r.localCount == null ? `${fmt(r.total)} species` : `${fmt(r.localCount)} local species · ${fmt(r.total)} total`;
}
