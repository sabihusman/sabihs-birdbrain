/**
 * Audio in IndexedDB when Safari will not store a Blob (DECISIONS.md #82).
 *
 * In a Safari private tab, putting a record that holds a Blob can fail with "Error preparing
 * Blob/File data to be stored in object store" (WebKit bug 268037 and earlier ones). When that
 * happens the same record is stored again with the audio as plain bytes (`audioBytes`, an
 * ArrayBuffer, plus its type) and no Blob; reading turns the bytes back into a Blob, so the rest
 * of the app never sees the difference. Normal browsers keep storing Blobs, which IndexedDB can
 * keep on disk instead of in memory.
 */

/** Fields a stored row may carry instead of `blob`. */
export interface BytesForm {
  audioBytes?: ArrayBuffer;
  audioType?: string;
}

/** The store refused the Blob itself (not, say, a full disk, which the retry would not help). */
export function isBlobStoreError(e: unknown): boolean {
  if (!(e instanceof Error) && !(typeof DOMException !== 'undefined' && e instanceof DOMException)) return false;
  const err = e as Error;
  if (err.name === 'QuotaExceededError') return false;
  return /blob|file/i.test(err.message) || err.name === 'DataCloneError';
}

/** The row with its Blob swapped for the Blob's bytes. */
export async function toBytesForm<T extends { blob: Blob }>(row: T): Promise<Omit<T, 'blob'> & BytesForm> {
  const { blob, ...rest } = row;
  return { ...rest, audioBytes: await blob.arrayBuffer(), audioType: blob.type };
}

/** A row as read back: a stored Blob is left alone, stored bytes become a Blob again. */
export function fromStored<T extends { blob: Blob }>(row: (Omit<T, 'blob'> & BytesForm & { blob?: Blob }) | undefined): T | undefined {
  if (!row) return undefined;
  if (row.blob || !row.audioBytes) return row as unknown as T;
  const { audioBytes, audioType, ...rest } = row;
  return { ...rest, blob: new Blob([audioBytes], { type: audioType ?? '' }) } as unknown as T;
}

/** Put a row with a Blob; if the store refuses the Blob, put the bytes form instead. */
export async function putWithBlobFallback<T extends { blob: Blob }>(put: (value: T | (Omit<T, 'blob'> & BytesForm)) => Promise<unknown>, row: T): Promise<'blob' | 'bytes'> {
  try {
    await put(row);
    return 'blob';
  } catch (e) {
    if (!isBlobStoreError(e)) throw e;
    await put(await toBytesForm(row));
    return 'bytes';
  }
}
