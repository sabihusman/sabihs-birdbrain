/**
 * First visit or returning visitor? (DECISIONS.md #68)
 *
 * The welcome layer is shown once, before anything is downloaded. Three signals say
 * that a phone has used Birdbrain before, and any one of them hides the welcome:
 *
 * - stored settings (the user changed something),
 * - the "model wanted" flag (the user tapped "Start identifying", or started
 *   listening, the sample clip or an import),
 * - the model files in the Cache API (a download finished here before),
 * - a signed-in session (an account on this phone; DECISIONS.md #81).
 *
 * The cache check is asynchronous and guarded: a browser without Cache Storage, or
 * one that refuses it in a private window, counts as "nothing cached".
 */
import { ACOUSTIC_MODEL_FILE, MODEL_CACHE_NAME } from '../model/constants';
import { SESSION_KEY } from '../api/client';
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
  /** A session is stored: someone signed in on this phone, so it is not a first visit (DECISIONS.md #81). */
  signedIn?: boolean;
}

/**
 * Load the model at startup only when this phone asked for it before: it is cached (a
 * download finished here) or the flag is set (the user started identifying, so the next
 * visit should be "Model ready" without a tap). Everyone else gets it on their first
 * identifying action (DECISIONS.md #69).
 */
export function shouldAutoLoadModel(s: Pick<VisitSignals, 'modelWanted' | 'modelCached'>): boolean {
  return s.modelCached || s.modelWanted;
}

/** The welcome layer shows only when nothing says this phone has used Birdbrain before. */
export function shouldShowWelcome(s: VisitSignals): boolean {
  return !s.settingsStored && !s.modelWanted && !s.modelCached && !s.signedIn;
}

/** The localStorage signals; a storage that throws (private mode, blocked site data) reads as empty. */
export function readStoredSignals(storage: Storage | null): Pick<VisitSignals, 'settingsStored' | 'modelWanted' | 'signedIn'> {
  try {
    return { settingsStored: storage?.getItem(SETTINGS_KEY) != null, modelWanted: storage?.getItem(MODEL_WANTED_KEY) === MODEL_WANTED_VALUE, signedIn: storage?.getItem(SESSION_KEY) != null };
  } catch {
    return { settingsStored: false, modelWanted: false, signedIn: false };
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
