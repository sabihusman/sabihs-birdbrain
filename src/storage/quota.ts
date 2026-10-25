export interface StorageStatus {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
  supported: boolean;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { usageBytes: null, quotaBytes: null, persisted: null, supported: false };
  }
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  let persisted: boolean | null = null;
  try {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      usageBytes = est.usage ?? null;
      quotaBytes = est.quota ?? null;
    }
  } catch {
    /* ignore */
  }
  try {
    if (navigator.storage.persisted) persisted = await navigator.storage.persisted();
  } catch {
    /* ignore */
  }
  return { usageBytes, quotaBytes, persisted, supported: true };
}

/** Ask the browser to keep our data; returns the result, or null if unsupported. */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

/** localStorage key: the one automatic request was made (DECISIONS.md #84). */
export const PERSIST_ASKED_KEY = 'birdbrain.persist-asked.v1';

/** Shown when the app asks, so a browser that prompts (Firefox) is not a surprise. */
export const PERSIST_REASON = 'Asking your browser to keep the model and sightings, so low space can’t delete them.';

/** The Settings explanation: why the app asks and what it changes. */
export const PERSIST_EXPLAINED =
  'Why: the model (78 MB) and your sightings live on this phone. Without this, the browser may delete them when space is low, and Safari clears sites left unused; anything not exported is lost. Chrome and Safari decide without asking; Firefox asks. Nothing leaves your phone.';

export type PersistOutcome = 'granted' | 'denied' | 'already' | 'asked-before' | 'unsupported';

type StorageManagerLike = Pick<StorageManager, 'persist' | 'persisted'>;

/**
 * Ask once, after the first model download (DECISIONS.md #84): web.dev advises against asking on
 * page load or asking again after a refusal. Already-persistent storage is only recorded. `onAsk`
 * runs just before the browser decides (and, in Firefox, prompts), to say why.
 */
export async function askToKeepStorageOnce(
  storage: Storage | null,
  manager: StorageManagerLike | undefined = typeof navigator === 'undefined' ? undefined : navigator.storage,
  onAsk: () => void = () => undefined,
): Promise<PersistOutcome> {
  try {
    if (storage?.getItem(PERSIST_ASKED_KEY)) return 'asked-before';
  } catch {
    return 'unsupported';
  }
  if (!manager?.persist) return 'unsupported';
  const remember = () => {
    try {
      storage?.setItem(PERSIST_ASKED_KEY, String(Date.now()));
    } catch {
      /* without storage it may ask again on a later download, which is harmless */
    }
  };
  try {
    if (manager.persisted && (await manager.persisted())) {
      remember();
      return 'already';
    }
    onAsk();
    const granted = await manager.persist();
    remember();
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unsupported';
  }
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}
