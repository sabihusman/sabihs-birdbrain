import { deleteDB, openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { clipWindows } from '../src/species/clips';
import { DB_NAME, DB_VERSION, getClip, getDB, listClips } from '../src/storage/db';

/**
 * Runs in its own file: getDB() is a singleton, so the hand-built version-3
 * database must exist before the app opens the database for the first time.
 */
describe('clips: upgrade from DB version 3 keeps clips without windows', () => {
  it('opens at version 4 and reads the old clip as "unknown windows"', async () => {
    await deleteDB(DB_NAME);
    const v3 = await openDB(DB_NAME, 3, {
      upgrade(db) {
        const rec = db.createObjectStore('recordings', { keyPath: 'id' });
        rec.createIndex('by-created', 'createdAt');
        const d = db.createObjectStore('detections', { keyPath: 'id' });
        d.createIndex('by-time', 'time');
        d.createIndex('by-scientific', 'scientific');
        d.createIndex('by-recording', 'recordingId');
        db.createObjectStore('wiki', { keyPath: 'key' });
        db.createObjectStore('clips', { keyPath: 'scientific' });
        const st = db.createObjectStore('sightings', { keyPath: 'id' });
        st.createIndex('by-scientific', 'scientific');
        st.createIndex('by-last', 'lastTime');
        st.createIndex('by-recording', 'recordingId');
      },
    });
    await v3.put('clips', { scientific: 'Turdus merula', common: 'Eurasian Blackbird', blob: new Blob([new Uint8Array(44)], { type: 'audio/wav' }), sampleRate: 48000, durationSec: 10, confidence: 0.8, time: 5, savedAt: 6, lat: 1, lon: 2, accuracy: 3, source: 'live', recordingId: null });
    v3.close();

    const db = await getDB();
    expect(DB_VERSION).toBe(4);
    expect(db.version).toBe(4);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['clips', 'detections', 'recordings', 'sightings', 'wiki']);
    const clips = await listClips();
    expect(clips.length).toBe(1);
    const clip = (await getClip('Turdus merula'))!;
    expect(clip.confidence).toBe(0.8);
    expect(clip.windows).toBeUndefined();
    expect(clipWindows(clip)).toBeNull();
  });
});
