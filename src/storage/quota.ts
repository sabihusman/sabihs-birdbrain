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
