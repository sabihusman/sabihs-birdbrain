/**
 * First visit or returning visitor? (DECISIONS.md #65)
 *
 * The welcome layer is shown once, before anything is downloaded. Three signals say
 * that a phone has used Birdbrain before, and any one of them hides the welcome:
 *
 * - stored settings (the user changed something),
 * - the "model wanted" flag (the user tapped "Start identifying", or started
 *   listening, the sample clip or an import),
 * - the model files in the Cache API (a download finished here before).
 *
 * The cache check is asynchronous and guarded: a browser without Cache Storage, or
 * one that refuses it in a private window, counts as "nothing cached".
 */
import { ACOUSTIC_MODEL_FILE, MODEL_CACHE_NAME } from '../model/constants';
import { SETTINGS_KEY } from './settings';

/** localStorage key set the first time the visitor asks for the model. */
export const MODEL_WANTED_KEY = 'birdbrain.model.v1';
const MODEL_WANTED_VALUE = 'wanted';

export interface VisitSignals {
  /** `birdbrain.settings.v1` exists in localStorage. */
  settingsStored: boolean;
  /** The visitor asked for the model before (MODEL_WANTED_KEY). */
  modelWanted: boolean;
  /** The acoustic model's `model.json` is in the model cache. */
  modelCached: boolean;
}

/** The welcome layer shows only when nothing says this phone has used Birdbrain before. */
export function shouldShowWelcome(s: VisitSignals): boolean {
  return !s.settingsStored && !s.modelWanted && !s.modelCached;
}

/** The two localStorage signals; a storage that throws (private mode, blocked site data) reads as empty. */
export function readStoredSignals(storage: Storage | null): Pick<VisitSignals, 'settingsStored' | 'modelWanted'> {
  try {
    return { settingsStored: storage?.getItem(SETTINGS_KEY) != null, modelWanted: storage?.getItem(MODEL_WANTED_KEY) === MODEL_WANTED_VALUE };
  } catch {
    return { settingsStored: false, modelWanted: false };
  }
}

/** Remember that the visitor asked for the model, so the welcome never comes back and later visits load it at once. */
export function markModelWanted(storage: Storage | null): void {
  try {
    storage?.setItem(MODEL_WANTED_KEY, MODEL_WANTED_VALUE);
  } catch {
    /* no storage: the welcome may show again next time, which is harmless */
  }
}

/** The subset of CacheStorage this module uses, so tests can pass a fake. */
export type ModelCacheStorage = Pick<CacheStorage, 'has'> & { open(name: string): Promise<Pick<Cache, 'match'>> };

/**
 * True when the acoustic model's entry point is in the model cache (the worker and the
 * service worker share `MODEL_CACHE_NAME`). `modelBaseUrl` may be relative; the Cache
 * API resolves it against the page like fetch does.
 */
export async function isModelCached(cacheStorage: ModelCacheStorage | undefined, modelBaseUrl: string): Promise<boolean> {
  if (!cacheStorage) return false;
  try {
    if (!(await cacheStorage.has(MODEL_CACHE_NAME))) return false;
    const cache = await cacheStorage.open(MODEL_CACHE_NAME);
    return (await cache.match(`${modelBaseUrl}${ACOUSTIC_MODEL_FILE}`)) !== undefined;
  } catch {
    return false;
  }
}

/** All three signals, read from the browser (or whatever the caller passes in). */
export async function readVisitSignals(storage: Storage | null, cacheStorage: ModelCacheStorage | undefined, modelBaseUrl: string): Promise<VisitSignals> {
  const [stored, modelCached] = await Promise.all([Promise.resolve(readStoredSignals(storage)), isModelCached(cacheStorage, modelBaseUrl)]);
  return { ...stored, modelCached };
}

/** The browser's localStorage, or null when touching it throws. */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
