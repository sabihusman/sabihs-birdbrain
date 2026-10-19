import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ClipRecord, DetectionRecord, RecordingRecord, SightingRecord, WikiCacheEntry } from './types';
import { applyDetection, buildSightings, canMerge, DEFAULT_SIGHTING_GAP_SECONDS, sightingFromDetection } from '../species/sightings';

interface BirdbrainDB extends DBSchema {
  recordings: {
    key: string;
    value: RecordingRecord;
    indexes: { 'by-created': number };
  };
  detections: {
    key: string;
    value: DetectionRecord;
    indexes: { 'by-time': number; 'by-scientific': string; 'by-recording': string };
  };
  wiki: {
    key: string;
    value: WikiCacheEntry;
  };
  clips: {
    key: string;
    value: ClipRecord;
  };
  sightings: {
    key: string;
    value: SightingRecord;
    indexes: { 'by-scientific': string; 'by-last': number; 'by-recording': string };
  };
}

export const DB_NAME = 'sabihs-birdbrain';
export const DB_VERSION = 5;

let dbPromise: Promise<IDBPDatabase<BirdbrainDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<BirdbrainDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BirdbrainDB>(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          const rec = db.createObjectStore('recordings', { keyPath: 'id' });
          rec.createIndex('by-created', 'createdAt');
          const det = db.createObjectStore('detections', { keyPath: 'id' });
          det.createIndex('by-time', 'time');
          det.createIndex('by-scientific', 'scientific');
          det.createIndex('by-recording', 'recordingId');
          db.createObjectStore('wiki', { keyPath: 'key' });
        }
        if (oldVersion < 2) {
          db.createObjectStore('clips', { keyPath: 'scientific' });
        }
        if (oldVersion < 3) {
          const st = db.createObjectStore('sightings', { keyPath: 'id' });
          st.createIndex('by-scientific', 'scientific');
          st.createIndex('by-last', 'lastTime');
          st.createIndex('by-recording', 'recordingId');
          // One-time migration: merge the existing per-window detections into sightings.
          if (oldVersion >= 1) await rebuildSightings(tx);
        }
        if (oldVersion < 4) {
          // Clips gain `windows` (the 3 s windows that triggered the ID). Existing records stay as they
          // are: a clip without `windows` is read as "unknown windows" (DECISIONS.md #42).
        }
        if (oldVersion < 5 && oldVersion >= 3) {
          // The sighting gap became the single 30 s rule shared with the Listen screen (was 60 s):
          // re-lump the stored sightings from the (unchanged) per-window hits.
          await rebuildSightings(tx);
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Rebuild the `sightings` store from every stored detection with the current
 * gap, inside an upgrade transaction that includes both stores. Detections are
 * never dropped or merged; only their `sightingId` links change.
 */
export async function rebuildSightings(tx: { objectStore(name: 'detections' | 'sightings'): { getAll(): Promise<unknown[]>; clear(): Promise<void>; put(v: unknown): Promise<unknown> } }, gapMs = DEFAULT_SIGHTING_GAP_SECONDS * 1000): Promise<void> {
  const detStore = tx.objectStore('detections');
  const st = tx.objectStore('sightings');
  const all = (await detStore.getAll()) as DetectionRecord[];
  const { sightings, assignments } = buildSightings(all, gapMs);
  await st.clear();
  for (const sgt of sightings) await st.put(sgt);
  for (const d of all) await detStore.put({ ...d, sightingId: assignments.get(d.id) });
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Recordings
export async function putRecording(rec: RecordingRecord): Promise<void> {
  const db = await getDB();
  await db.put('recordings', rec);
}

export async function getRecording(id: string): Promise<RecordingRecord | undefined> {
  const db = await getDB();
  return db.get('recordings', id);
}

export async function listRecordings(): Promise<RecordingRecord[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('recordings', 'by-created');
  return all.reverse();
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordings', 'detections', 'sightings'], 'readwrite');
  await tx.objectStore('recordings').delete(id);
  for (const key of await tx.objectStore('detections').index('by-recording').getAllKeys(id)) await tx.objectStore('detections').delete(key);
  for (const key of await tx.objectStore('sightings').index('by-recording').getAllKeys(id)) await tx.objectStore('sightings').delete(key);
  await tx.done;
}

// Detections and sightings ----------------------------------------------------

/**
 * Store per-window detections and fold each into its sighting: the most
 * recent sighting of the same species and stream within `gapMs`, else a new
 * one. Returns the sightings that were created or extended.
 */
export async function recordDetections(dets: DetectionRecord[], gapMs = DEFAULT_SIGHTING_GAP_SECONDS * 1000): Promise<SightingRecord[]> {
  if (dets.length === 0) return [];
  const db = await getDB();
  const tx = db.transaction(['detections', 'sightings'], 'readwrite');
  const sightings = tx.objectStore('sightings');
  const touched = new Map<string, SightingRecord>();
  for (const d of dets.slice().sort((a, b) => a.time - b.time)) {
    let target = Array.from(touched.values()).find((s) => canMerge(s, d, gapMs));
    if (!target) {
      const candidates = await sightings.index('by-scientific').getAll(d.scientific);
      target = candidates.filter((s) => canMerge(s, d, gapMs)).sort((a, b) => b.lastTime - a.lastTime)[0];
    }
    if (target) applyDetection(target, d);
    else target = sightingFromDetection(d);
    touched.set(target.id, target);
    await tx.objectStore('detections').put({ ...d, sightingId: target.id });
  }
  for (const s of touched.values()) await sightings.put(s);
  await tx.done;
  return Array.from(touched.values());
}

export async function listSightings(): Promise<SightingRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('sightings', 'by-last');
}

export async function listSightingsForSpecies(scientific: string): Promise<SightingRecord[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('sightings', 'by-scientific', scientific);
  return all.sort((a, b) => a.firstTime - b.firstTime);
}

/**
 * Scientific names with at least one sighting, read from the unique keys of
 * the `by-scientific` index (no sighting rows are loaded). Used for the
 * "spotted" ticks on the Species tab.
 */
export async function listSightedSpecies(): Promise<string[]> {
  const db = await getDB();
  const index = db.transaction('sightings').store.index('by-scientific');
  const out: string[] = [];
  let cursor = await index.openKeyCursor(null, 'nextunique');
  while (cursor) {
    out.push(cursor.key);
    cursor = await cursor.continue();
  }
  return out;
}

export async function countSightings(): Promise<number> {
  const db = await getDB();
  return db.count('sightings');
}

export async function listDetections(): Promise<DetectionRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('detections', 'by-time');
}

export async function listDetectionsForSpecies(scientific: string): Promise<DetectionRecord[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('detections', 'by-scientific', scientific);
  return all.sort((a, b) => a.time - b.time);
}

export async function listDetectionsForRecording(recordingId: string): Promise<DetectionRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('detections', 'by-recording', recordingId);
}

/** Remove a recording's detections and sightings (before a re-analysis). */
export async function deleteDetectionsForRecording(recordingId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['detections', 'sightings'], 'readwrite');
  for (const k of await tx.objectStore('detections').index('by-recording').getAllKeys(recordingId)) await tx.objectStore('detections').delete(k);
  for (const k of await tx.objectStore('sightings').index('by-recording').getAllKeys(recordingId)) await tx.objectStore('sightings').delete(k);
  await tx.done;
}

export async function countDetections(): Promise<number> {
  const db = await getDB();
  return db.count('detections');
}

// Wikipedia cache
export async function getWikiCache(key: string): Promise<WikiCacheEntry | undefined> {
  const db = await getDB();
  return db.get('wiki', key);
}

export async function putWikiCache(entry: WikiCacheEntry): Promise<void> {
  const db = await getDB();
  await db.put('wiki', entry);
}

// Species clips (one per species)
export async function getClip(scientific: string): Promise<ClipRecord | undefined> {
  const db = await getDB();
  return db.get('clips', scientific);
}

export async function putClip(clip: ClipRecord): Promise<void> {
  const db = await getDB();
  await db.put('clips', clip);
}

export async function deleteClip(scientific: string): Promise<void> {
  const db = await getDB();
  await db.delete('clips', scientific);
}

export async function listClips(): Promise<ClipRecord[]> {
  const db = await getDB();
  return db.getAll('clips');
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordings', 'detections', 'wiki', 'clips', 'sightings'], 'readwrite');
  await Promise.all([tx.objectStore('recordings').clear(), tx.objectStore('detections').clear(), tx.objectStore('wiki').clear(), tx.objectStore('clips').clear(), tx.objectStore('sightings').clear()]);
  await tx.done;
}
