import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { fromStored, isBlobStoreError, putWithBlobFallback, toBytesForm } from '../src/storage/blob-fallback';
import { DB_NAME, getClip, getRecording, listClips, putClip, putRecording } from '../src/storage/db';
import type { ClipRecord, RecordingRecord } from '../src/storage/types';

/** What Safari throws in a private tab (WebKit bug 268037). */
function safariBlobError(): Error {
  const e = new Error('Error preparing Blob/File data to be stored in object store');
  e.name = 'UnknownError';
  return e;
}

const wav = () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3])], { type: 'audio/wav' });

describe('audio storage when Safari refuses Blobs (DECISIONS.md #82)', () => {
  it('stores the bytes instead when the Blob is refused, and reading gives the same Blob back', async () => {
    const stored: unknown[] = [];
    const put = async (v: unknown) => {
      if ((v as { blob?: unknown }).blob instanceof Blob) throw safariBlobError();
      stored.push(v);
    };
    const row = { id: 'r1', name: 'x', blob: wav() };
    expect(await putWithBlobFallback(put, row)).toBe('bytes');
    const saved = stored[0] as Record<string, unknown>;
    expect(saved.blob).toBeUndefined();
    expect(saved.audioBytes).toBeInstanceOf(ArrayBuffer);
    expect(saved.audioType).toBe('audio/wav');
    const back = fromStored<typeof row>(saved as never)!;
    expect(back.id).toBe('r1');
    expect(back.blob.type).toBe('audio/wav');
    expect(Array.from(new Uint8Array(await back.blob.arrayBuffer()))).toEqual([82, 73, 70, 70, 1, 2, 3]);
    expect('audioBytes' in back).toBe(false);
  });

  it('keeps Blobs where they work, and does not retry for a full disk or other errors', async () => {
    const ok: unknown[] = [];
    expect(await putWithBlobFallback(async (v) => void ok.push(v), { id: 'a', blob: wav() })).toBe('blob');
    expect((ok[0] as { blob: Blob }).blob).toBeInstanceOf(Blob);
    const quota = new Error('quota');
    quota.name = 'QuotaExceededError';
    let calls = 0;
    await expect(
      putWithBlobFallback(async () => {
        calls++;
        throw quota;
      }, { id: 'b', blob: wav() }),
    ).rejects.toBe(quota);
    expect(calls).toBe(1);
    expect(isBlobStoreError(safariBlobError())).toBe(true);
    expect(isBlobStoreError(Object.assign(new Error('could not clone'), { name: 'DataCloneError' }))).toBe(true);
    expect(isBlobStoreError(new Error('Transaction aborted'))).toBe(false);
    expect(isBlobStoreError('nope')).toBe(false);
  });

  it('reads a row stored either way, and leaves a stored Blob alone', async () => {
    const blobRow = { id: 'c', blob: wav() };
    expect(fromStored<typeof blobRow>(blobRow)).toBe(blobRow);
    expect(fromStored<typeof blobRow>(undefined)).toBeUndefined();
    const bytes = await toBytesForm(blobRow);
    expect(Object.keys(bytes).sort()).toEqual(['audioBytes', 'audioType', 'id']);
  });

  it('the database functions read a recording and a clip saved as bytes', async () => {
    const rec: RecordingRecord = { id: 'rec-bytes', createdAt: 1, name: 'Auto-saved: Robin', durationSec: 3, sampleRate: 48000, bytes: 7, blob: wav(), source: 'autoclip', lat: null, lon: null, accuracy: null, fixTime: null, summary: [], analyzedAt: null };
    const clip = { scientific: 'Turdus migratorius', common: 'American Robin', blob: wav(), sampleRate: 48000, durationSec: 3, confidence: 0.9, time: 1, savedAt: 1, lat: null, lon: null, accuracy: null } as unknown as ClipRecord;
    // Save once through the app (creates the stores), then overwrite with the bytes form as Safari's fallback would.
    await putRecording(rec);
    await putClip(clip);
    const db = await openDB(DB_NAME);
    await db.put('recordings', await toBytesForm(rec));
    await db.put('clips', await toBytesForm(clip));
    db.close();
    const r = (await getRecording('rec-bytes'))!;
    expect(r.blob).toBeInstanceOf(Blob);
    expect(r.blob.size).toBe(7);
    expect((await getClip('Turdus migratorius'))!.blob.type).toBe('audio/wav');
    // Lists carry details only (DECISIONS.md #87); a row from before keeps its audio and still plays.
    expect('blob' in (await listClips()).find((c) => c.scientific === 'Turdus migratorius')!).toBe(false);
  });
});
