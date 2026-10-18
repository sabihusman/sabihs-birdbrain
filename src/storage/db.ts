import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DetectionRecord, RecordingRecord, WikiCacheEntry } from './types';

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
}

const DB_NAME = 'sabihs-birdbrain';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<BirdbrainDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<BirdbrainDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BirdbrainDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const rec = db.createObjectStore('recordings', { keyPath: 'id' });
        rec.createIndex('by-created', 'createdAt');
        const det = db.createObjectStore('detections', { keyPath: 'id' });
        det.createIndex('by-time', 'time');
        det.createIndex('by-scientific', 'scientific');
        det.createIndex('by-recording', 'recordingId');
        db.createObjectStore('wiki', { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
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
  const tx = db.transaction(['recordings', 'detections'], 'readwrite');
  await tx.objectStore('recordings').delete(id);
  const dets = await tx.objectStore('detections').index('by-recording').getAllKeys(id);
  for (const key of dets) await tx.objectStore('detections').delete(key);
  await tx.done;
}

// Detections
export async function addDetections(dets: DetectionRecord[]): Promise<void> {
  if (dets.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('detections', 'readwrite');
  for (const d of dets) await tx.store.put(d);
  await tx.done;
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

export async function deleteDetectionsForRecording(recordingId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('detections', 'readwrite');
  const keys = await tx.store.index('by-recording').getAllKeys(recordingId);
  for (const k of keys) await tx.store.delete(k);
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

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordings', 'detections', 'wiki'], 'readwrite');
  await Promise.all([tx.objectStore('recordings').clear(), tx.objectStore('detections').clear(), tx.objectStore('wiki').clear()]);
  await tx.done;
}
