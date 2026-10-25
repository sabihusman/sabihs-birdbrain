import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { clearAllData, DB_NAME, deleteClip, deleteRecording, getClip, getClipMeta, getDB, getRecording, getRecordingMeta, listClips, listRecordings, putClip, putRecording } from '../src/storage/db';
import type { ClipRecord, RecordingRecord } from '../src/storage/types';

const wav = (n: number) => new Blob([new Uint8Array(n)], { type: 'audio/wav' });
const rec = (id: string, n = 9): RecordingRecord => ({ id, createdAt: Date.now(), name: `Rec ${id}`, durationSec: 3, sampleRate: 48000, bytes: n, blob: wav(n), source: 'mic', lat: null, lon: null, accuracy: null, fixTime: null, summary: [], analyzedAt: null });
const clip = (scientific: string, n = 5): ClipRecord => ({ scientific, common: 'Bird', blob: wav(n), sampleRate: 48000, durationSec: 3, confidence: 0.7, time: 1, savedAt: 1, lat: null, lon: null, accuracy: null, source: 'live', recordingId: null }) as ClipRecord;

async function raw(store: string, key: string): Promise<Record<string, unknown> | undefined> {
  const db = await openDB(DB_NAME);
  try {
    return (await db.get(store, key)) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

describe('audio in its own store (DECISIONS.md #87)', () => {
  beforeEach(async () => {
    await getDB();
    await clearAllData();
  });

  it('keeps a recording’s details apart from its audio; lists never carry audio', async () => {
    await putRecording(rec('r1', 11));
    const row = await raw('recordings', 'r1');
    expect(row).toBeDefined();
    expect('blob' in row!).toBe(false);
    expect((await raw('audio', 'rec:r1'))?.blob).toBeInstanceOf(Blob);
    const listed = await listRecordings();
    expect(listed.map((r) => r.id)).toEqual(['r1']);
    expect('blob' in listed[0]).toBe(false);
    expect('blob' in (await getRecordingMeta('r1'))!).toBe(false);
    const full = (await getRecording('r1'))!;
    expect(full.name).toBe('Rec r1');
    expect(full.blob.size).toBe(11);
  });

  it('does the same for clips, and deleting removes the audio too', async () => {
    await putClip(clip('Parus major', 6));
    expect('blob' in (await raw('clips', 'Parus major'))!).toBe(false);
    expect('blob' in (await listClips())[0]).toBe(false);
    expect((await getClipMeta('Parus major'))!.confidence).toBe(0.7);
    expect((await getClip('Parus major'))!.blob.size).toBe(6);
    await deleteClip('Parus major');
    expect(await raw('audio', 'clip:Parus major')).toBeUndefined();
    await putRecording(rec('r2'));
    await deleteRecording('r2');
    expect(await raw('audio', 'rec:r2')).toBeUndefined();
    expect(await getRecording('r2')).toBeUndefined();
  });

  it('still reads a recording saved before the split, with its audio inside the row', async () => {
    const db = await openDB(DB_NAME);
    await db.put('recordings', rec('old', 13));
    db.close();
    expect((await getRecording('old'))!.blob.size).toBe(13);
    expect('blob' in (await listRecordings()).find((r) => r.id === 'old')!).toBe(false);
  });

  it('Delete all data clears the audio store as well', async () => {
    await putRecording(rec('r3'));
    await putClip(clip('Turdus merula'));
    await clearAllData();
    expect(await raw('audio', 'rec:r3')).toBeUndefined();
    expect(await raw('audio', 'clip:Turdus merula')).toBeUndefined();
  });
});
