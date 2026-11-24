import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ClipMeta, ClipRecord, DetectionRecord, RecordingMeta, RecordingRecord, SightingRecord, WikiCacheEntry } from './types';
import { canonicalName, renamed, storedNames } from '../species/names';
import { applyDetection, buildSightings, canMerge, DEFAULT_SIGHTING_GAP_SECONDS, sightingFromDetection } from '../species/sightings';
import { fromStored, putWithBlobFallback, type BytesForm } from './blob-fallback';

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
  /** Audio of recordings (`rec:<id>`) and clips (`clip:<scientific>`), apart from their details (DECISIONS.md #87). */
  audio: {
    key: string;
    value: AudioRow;
  };
}

/** One stored sound: a Blob, or its bytes where Safari refuses Blobs (DECISIONS.md #82). */
interface AudioRow extends BytesForm {
  key: string;
  blob?: Blob;
}

const recAudioKey = (id: string) => `rec:${id}`;
const clipAudioKey = (scientific: string) => `clip:${scientific}`;

/** Details only: drops any audio a row from before DECISIONS.md #87 still carries. */
function metaOf<T extends object>(row: T): Omit<T, 'blob' | 'audioBytes' | 'audioType'> {
  const { blob: _b, audioBytes: _a, audioType: _t, ...meta } = row as T & { blob?: unknown; audioBytes?: unknown; audioType?: unknown };
  return meta;
}

/** The audio of a row: from the audio store, else (older rows) from the row itself. */
function audioOf(audio: AudioRow | undefined, legacy: (BytesForm & { blob?: Blob }) | undefined): Blob | undefined {
  return fromStored<{ blob: Blob }>(audio as never)?.blob ?? fromStored<{ blob: Blob }>(legacy as never)?.blob;
}

export const DB_NAME = 'sabihs-birdbrain';
export const DB_VERSION = 6;

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
        if (oldVersion < 6) {
          // Audio moves to its own store so listing recordings never reads audio (DECISIONS.md #87).
          // Existing rows are not rewritten here (a Safari private tab can refuse to store a Blob
          // again, which would abort the whole upgrade); they keep their audio and are still read.
          db.createObjectStore('audio', { keyPath: 'key' });
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

// Recordings: details in `recordings`, audio in `audio` (DECISIONS.md #82, #87)
export async function putRecording(rec: RecordingRecord): Promise<void> {
  const db = await getDB();
  await putWithBlobFallback((v) => db.put('audio', v as AudioRow), { key: recAudioKey(rec.id), blob: rec.blob });
  await db.put('recordings', metaOf(rec) as RecordingRecord);
}

/** One recording with its audio (the player, re-analysis and export need it). */
export async function getRecording(id: string): Promise<RecordingRecord | undefined> {
  const db = await getDB();
  const row = await db.get('recordings', id);
  if (!row) return undefined;
  const blob = audioOf(await db.get('audio', recAudioKey(id)), row as BytesForm & { blob?: Blob });
  return blob ? { ...metaOf(row), blob } : undefined;
}

/** One recording's details, without reading its audio. */
export async function getRecordingMeta(id: string): Promise<RecordingMeta | undefined> {
  const db = await getDB();
  const row = await db.get('recordings', id);
  return row ? metaOf(row) : undefined;
}

/** Every recording's details, newest first. No audio is read. */
export async function listRecordings(): Promise<RecordingMeta[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('recordings', 'by-created');
  return all.reverse().map((r) => metaOf(r));
}

/**
 * Delete a recording, its audio and the birds found in it. A sighting that also has windows outside the recording (a
 * live sighting whose best window was auto-saved) keeps those windows, re-counted (DECISIONS.md #138).
 */
export async function deleteRecording(id: string): Promise<void> {
  await removeDetections((d) => d.recordingId === id, { alsoRecordings: [id] });
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

/*
 * Reads below show each row under the running model's name (src/species/names.ts, DECISIONS.md #136): a bird saved as
 * "Accipiter cooperii" with V2.4 is listed as "Astur cooperii" while V3.0 runs, and asking for a species also finds
 * rows saved under its other names. Writes keep the name they are given.
 */

export async function listSightings(): Promise<SightingRecord[]> {
  const db = await getDB();
  return (await db.getAllFromIndex('sightings', 'by-last')).map(renamed);
}

export async function listSightingsForSpecies(scientific: string): Promise<SightingRecord[]> {
  const db = await getDB();
  const all = (await Promise.all(storedNames(scientific).map((name) => db.getAllFromIndex('sightings', 'by-scientific', name)))).flat();
  return all.map(renamed).sort((a, b) => a.firstTime - b.firstTime);
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
    out.push(canonicalName(cursor.key));
    cursor = await cursor.continue();
  }
  return [...new Set(out)];
}

export async function countSightings(): Promise<number> {
  const db = await getDB();
  return db.count('sightings');
}

export async function listDetections(): Promise<DetectionRecord[]> {
  const db = await getDB();
  return (await db.getAllFromIndex('detections', 'by-time')).map(renamed);
}

export async function listDetectionsForSpecies(scientific: string): Promise<DetectionRecord[]> {
  const db = await getDB();
  const all = (await Promise.all(storedNames(scientific).map((name) => db.getAllFromIndex('detections', 'by-scientific', name)))).flat();
  return all.map(renamed).sort((a, b) => a.time - b.time);
}

export async function listDetectionsForRecording(recordingId: string): Promise<DetectionRecord[]> {
  const db = await getDB();
  return (await db.getAllFromIndex('detections', 'by-recording', recordingId)).map(renamed);
}

/** Remove a recording's detections and sightings (before a re-analysis). The recording itself stays. */
export async function deleteDetectionsForRecording(recordingId: string): Promise<void> {
  await removeDetections((d) => d.recordingId === recordingId, { keepRecordings: [recordingId] });
}

// Removing birds (DECISIONS.md #138) ----------------------------------------------

/** What a removal takes away, counted before it runs so the question can say so. */
export interface RemovalPlan {
  /** The birds it touches, under the running model's names. */
  birds: string[];
  /** Per-window detections removed. */
  detections: number;
  /** Sightings left with no window at all, so removed (a sighting with windows left is re-counted instead). */
  sightings: number;
  /** Auto-saved 3 s recordings left without any bird, so removed with their audio. Recordings made by hand stay. */
  autoClips: string[];
  /** Species sound clips (members' ID card) removed, by stored name. */
  speciesClips: string[];
}

interface RemoveOptions {
  /** Count only; change nothing. */
  dryRun?: boolean;
  /** Recordings deleted outright with their audio (the one being deleted). */
  alsoRecordings?: string[];
  /** Recordings that stay even when no bird is left in them (one about to be re-analysed). */
  keepRecordings?: string[];
  /** Species clips to remove with the detections. */
  clipMatch?: (clip: ClipMeta) => boolean;
}

/**
 * Remove every detection `match` accepts, in one transaction: sightings left empty go, sightings with windows left are
 * rebuilt from those windows, and an auto-saved clip left with no bird goes too, so nothing points at a missing row.
 */
export async function removeDetections(match: (d: DetectionRecord) => boolean, opts: RemoveOptions = {}): Promise<RemovalPlan> {
  const db = await getDB();
  // One read-write transaction even for a count, so the count and the removal see the same rows.
  const tx = db.transaction(['recordings', 'audio', 'detections', 'sightings', 'clips'], 'readwrite');
  const all = await tx.objectStore('detections').getAll();
  const gone = all.filter(match);
  const goneIds = new Set(gone.map((d) => d.id));
  const kept = all.filter((d) => !goneIds.has(d.id));

  const touchedSightings = new Set(gone.map((d) => d.sightingId).filter((x): x is string => !!x));
  const keptBySighting = new Map<string, DetectionRecord[]>();
  for (const d of kept) if (d.sightingId && touchedSightings.has(d.sightingId)) keptBySighting.set(d.sightingId, [...(keptBySighting.get(d.sightingId) ?? []), d]);
  const emptySightings = [...touchedSightings].filter((id) => !keptBySighting.has(id));

  const keep = new Set(opts.keepRecordings ?? []);
  const also = new Set(opts.alsoRecordings ?? []);
  const stillUsed = new Set(kept.map((d) => d.recordingId).filter((x): x is string => !!x));
  const autoClips: string[] = [];
  for (const id of new Set(gone.map((d) => d.recordingId).filter((x): x is string => !!x))) {
    if (keep.has(id) || also.has(id) || stillUsed.has(id)) continue;
    if ((await tx.objectStore('recordings').get(id))?.source === 'autoclip') autoClips.push(id);
  }
  const clips = opts.clipMatch ? (await tx.objectStore('clips').getAll()).map((c) => metaOf(c)).filter(opts.clipMatch) : [];
  const plan: RemovalPlan = {
    birds: [...new Set(gone.map((d) => canonicalName(d.scientific)))].sort((a, b) => a.localeCompare(b)),
    detections: gone.length,
    sightings: emptySightings.length,
    autoClips,
    speciesClips: clips.map((c) => c.scientific),
  };
  if (opts.dryRun) {
    await tx.done;
    return plan;
  }

  const detections = tx.objectStore('detections');
  const sightings = tx.objectStore('sightings');
  for (const d of gone) await detections.delete(d.id);
  for (const id of emptySightings) await sightings.delete(id);
  for (const [id, rest] of keptBySighting) {
    const [first, ...others] = rest.slice().sort((a, b) => a.time - b.time);
    const rebuilt = sightingFromDetection(first, id);
    for (const d of others) applyDetection(rebuilt, d);
    await sightings.put(rebuilt);
  }
  // Rows from before DB version 3 have no sighting link: their recording's sightings go with the recording.
  for (const id of also) for (const key of await sightings.index('by-recording').getAllKeys(id)) if (!keptBySighting.has(key)) await sightings.delete(key);
  for (const id of [...also, ...autoClips]) {
    await tx.objectStore('recordings').delete(id);
    await tx.objectStore('audio').delete(recAudioKey(id));
  }
  // A recording that keeps other birds drops the removed ones from its stored summary, which Recordings groups by.
  const removedRecs = new Set([...also, ...autoClips]);
  for (const id of new Set(gone.map((d) => d.recordingId).filter((x): x is string => !!x && !removedRecs.has(x)))) {
    const row = await tx.objectStore('recordings').get(id);
    if (!row) continue;
    const left = new Set(kept.filter((d) => d.recordingId === id).map((d) => canonicalName(d.scientific)));
    const summary = row.summary.filter((e) => left.has(canonicalName(e.scientific)));
    if (summary.length !== row.summary.length) await tx.objectStore('recordings').put({ ...row, summary });
  }
  for (const name of plan.speciesClips) {
    await tx.objectStore('clips').delete(name);
    await tx.objectStore('audio').delete(clipAudioKey(name));
  }
  await tx.done;
  return plan;
}

/** "Remove from my birds" on a species page: every window of the bird on this phone, under any of its names. */
export function removeSpecies(scientific: string, dryRun = false): Promise<RemovalPlan> {
  const names = new Set(storedNames(scientific));
  return removeDetections((d) => names.has(d.scientific), { dryRun, clipMatch: (c) => names.has(c.scientific) });
}

/**
 * Deleting a recording can also take the same birds out of the listen it came from (Sabih, Nov 24: birds from a
 * video kept showing after their recordings were deleted). Only live listening has such a listen; a recording made
 * or imported on its own has nothing else. The recording itself is left to `deleteRecording`.
 */
export async function removeListenBirds(recordingId: string, dryRun = false): Promise<RemovalPlan> {
  const db = await getDB();
  const own = await db.getAllFromIndex('detections', 'by-recording', recordingId);
  const live = own.filter((d) => d.source === 'live');
  const sessions = new Set(live.map((d) => d.sessionId));
  const names = new Set(live.flatMap((d) => storedNames(canonicalName(d.scientific))));
  if (sessions.size === 0) return { birds: [], detections: 0, sightings: 0, autoClips: [], speciesClips: [] };
  const match = (d: DetectionRecord) => d.recordingId !== recordingId && d.source === 'live' && sessions.has(d.sessionId) && names.has(d.scientific);
  // The species clip goes when it was cut from this listen: its window is one of the windows removed.
  const times = new Set((await db.getAll('detections')).filter((d) => match(d) || d.recordingId === recordingId).map((d) => `${d.scientific}\u0000${d.time}`));
  return removeDetections(match, { dryRun, keepRecordings: [recordingId], clipMatch: (c) => times.has(`${c.scientific}\u0000${c.time}`) });
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

// Species clips (one per species): details in `clips`, audio in `audio` (DECISIONS.md #87)
/** One clip with its audio, for the players. */
export async function getClip(scientific: string): Promise<ClipRecord | undefined> {
  const db = await getDB();
  const key = (await bestClipRow(db, scientific))?.scientific;
  const row = key === undefined ? undefined : await db.get('clips', key);
  if (!row || key === undefined) return undefined;
  const blob = audioOf(await db.get('audio', clipAudioKey(key)), row as BytesForm & { blob?: Blob });
  return blob ? renamed({ ...metaOf(row), blob }) : undefined;
}

/** One clip's details (confidence, time, windows), without reading its audio. */
export async function getClipMeta(scientific: string): Promise<ClipMeta | undefined> {
  const db = await getDB();
  const row = await bestClipRow(db, scientific);
  return row ? renamed(row) : undefined;
}

/** The most confident clip saved under any of the species' names (one per name; DECISIONS.md #136). */
async function bestClipRow(db: IDBPDatabase<BirdbrainDB>, scientific: string): Promise<ClipMeta | undefined> {
  const rows = (await Promise.all(storedNames(scientific).map((name) => db.get('clips', name)))).filter((r) => r !== undefined).map((r) => metaOf(r));
  return rows.sort((a, b) => b.confidence - a.confidence)[0];
}

export async function putClip(clip: ClipRecord): Promise<void> {
  const db = await getDB();
  await putWithBlobFallback((v) => db.put('audio', v as AudioRow), { key: clipAudioKey(clip.scientific), blob: clip.blob });
  await db.put('clips', metaOf(clip) as ClipRecord);
}

export async function deleteClip(scientific: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['clips', 'audio'], 'readwrite');
  await tx.objectStore('clips').delete(scientific);
  await tx.objectStore('audio').delete(clipAudioKey(scientific));
  await tx.done;
}

/** Every clip's details. No audio is read. */
export async function listClips(): Promise<ClipMeta[]> {
  const db = await getDB();
  // Two clips of one bird saved under its two names: keep the more confident.
  const best = new Map<string, ClipMeta>();
  for (const c of (await db.getAll('clips')).map((r) => renamed(metaOf(r)))) {
    const had = best.get(c.scientific);
    if (!had || c.confidence > had.confidence) best.set(c.scientific, c);
  }
  return [...best.values()];
}

export async function clearAllData(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['recordings', 'detections', 'wiki', 'clips', 'sightings', 'audio'], 'readwrite');
  await Promise.all([tx.objectStore('recordings').clear(), tx.objectStore('detections').clear(), tx.objectStore('wiki').clear(), tx.objectStore('clips').clear(), tx.objectStore('sightings').clear(), tx.objectStore('audio').clear()]);
  await tx.done;
}
