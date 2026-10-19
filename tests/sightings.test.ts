import { deleteDB, openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyDetection, buildSightings, canMerge, DEFAULT_SIGHTING_GAP_SECONDS, sightingFromDetection, sightingStreamKey } from '../src/species/sightings';
import { countSightings, DB_NAME, getDB, listDetections, listSightings, listSightingsForSpecies, rebuildSightings, recordDetections, deleteDetectionsForRecording, deleteRecording, putRecording } from '../src/storage/db';
import type { DetectionRecord } from '../src/storage/types';

const GAP = DEFAULT_SIGHTING_GAP_SECONDS * 1000;
let n = 0;
const det = (over: Partial<DetectionRecord> = {}): DetectionRecord => ({
  id: `d${++n}`,
  time: 0,
  label: 'Turdus merula_Eurasian Blackbird',
  scientific: 'Turdus merula',
  common: 'Eurasian Blackbird',
  confidence: 0.7,
  lat: null,
  lon: null,
  accuracy: null,
  recordingId: null,
  offsetSec: null,
  source: 'live',
  sessionId: 's1',
  ...over,
});

describe('sightings: merging rules', () => {
  it('the gap is the single 30 s rule shared with the Listen screen', () => {
    expect(DEFAULT_SIGHTING_GAP_SECONDS).toBe(30);
  });

  it('consecutive detections within the gap merge; a gap of more than 30 s starts a new sighting', () => {
    const dets = [det({ time: 0, confidence: 0.6 }), det({ time: 3000, confidence: 0.9, lat: 1, lon: 2, accuracy: 5 }), det({ time: 3000 + GAP, confidence: 0.5 }), det({ time: 3000 + GAP + GAP + 1, confidence: 0.8 })];
    let ids = 0;
    const { sightings, assignments } = buildSightings(dets, GAP, () => `s${++ids}`);
    expect(sightings.length).toBe(2);
    expect(sightings[0]).toMatchObject({ firstTime: 0, lastTime: 3000 + GAP, peakConfidence: 0.9, hits: 3, lat: 1, lon: 2, peakDetectionId: 'd2' });
    expect(sightings[1]).toMatchObject({ firstTime: 3000 + GAP + GAP + 1, hits: 1, peakConfidence: 0.8 });
    expect(assignments.get('d3')).toBe(sightings[0].id);
    expect(assignments.get('d4')).toBe(sightings[1].id);
  });

  it('different species never merge; live sessions merge by time; recordings merge only within themselves', () => {
    const a = det({ time: 0 });
    const b = det({ time: 1000, scientific: 'Parus major', common: 'Great Tit', label: 'Parus major_Great Tit' });
    const c = det({ time: 2000, sessionId: 's2' }); // a later live session, 2 s later: same sighting
    const r1 = det({ time: 3000, source: 'recording', recordingId: 'r1', offsetSec: 0, sessionId: 'rec-r1' });
    const r2 = det({ time: 4000, source: 'recording', recordingId: 'r2', offsetSec: 0, sessionId: 'rec-r2' });
    const { sightings } = buildSightings([a, b, c, r1, r2], GAP);
    expect(sightings.map((s) => `${s.scientific}/${s.source}/${s.hits}`)).toEqual(['Turdus merula/live/2', 'Parus major/live/1', 'Turdus merula/recording/1', 'Turdus merula/recording/1']);
    expect(sightingStreamKey(a)).toBe(sightingStreamKey(c));
    expect(sightingStreamKey(r1)).not.toBe(sightingStreamKey(r2));
    expect(canMerge(sightingFromDetection(a, 'x'), r1, GAP)).toBe(false);
  });

  it('keeps the peak window\'s position, or the first located one when the peak has none', () => {
    const s = sightingFromDetection(det({ time: 0, confidence: 0.5 }), 'x');
    applyDetection(s, det({ time: 1000, confidence: 0.4, lat: 10, lon: 20, accuracy: 3 }));
    expect(s).toMatchObject({ peakConfidence: 0.5, lat: 10, lon: 20, hits: 2 });
    applyDetection(s, det({ time: 2000, confidence: 0.95, recordingId: 'r', offsetSec: 6 }));
    expect(s).toMatchObject({ peakConfidence: 0.95, lat: 10, lon: 20, recordingId: 'r', offsetSec: 6, hits: 3 }); // peak without position keeps the known one
    applyDetection(s, det({ time: 2500, confidence: 0.99, lat: 30, lon: 40 }));
    expect(s).toMatchObject({ peakConfidence: 0.99, lat: 30, lon: 40 });
  });
});

describe('sightings: storage', () => {
  beforeEach(async () => {
    const db = await getDB();
    const tx = db.transaction(['detections', 'sightings', 'recordings'], 'readwrite');
    await Promise.all([tx.objectStore('detections').clear(), tx.objectStore('sightings').clear(), tx.objectStore('recordings').clear()]);
    await tx.done;
  });

  it('recordDetections folds windows into sightings across calls and links each detection', async () => {
    const first = await recordDetections([det({ time: 0, confidence: 0.6 }), det({ time: 3000, confidence: 0.8 })], GAP);
    expect(first.length).toBe(1);
    expect(first[0].hits).toBe(2);
    const second = await recordDetections([det({ time: 30_000, confidence: 0.7, lat: 1, lon: 1 })], GAP);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0]).toMatchObject({ hits: 3, peakConfidence: 0.8, lat: 1, lon: 1 });
    const third = await recordDetections([det({ time: 30_000 + GAP + 1 })], GAP);
    expect(third[0].id).not.toBe(first[0].id);
    expect(await countSightings()).toBe(2);
    const dets = await listDetections();
    expect(dets.every((d) => d.sightingId)).toBe(true);
    expect(new Set(dets.map((d) => d.sightingId)).size).toBe(2);
    expect((await listSightingsForSpecies('Turdus merula')).map((s) => s.hits)).toEqual([3, 1]);
  });

  it('the phone sequence (Bluebird :15 :17 :18 :20, Dove :06 :08 :09) keeps every hit stored and merges each species into one 60 s sighting', async () => {
    const T = Date.parse('2026-10-19T15:34:00');
    const blue = (sec: number, over: Partial<DetectionRecord> = {}) => det({ time: T + sec * 1000, label: 'Sialia sialis_Eastern Bluebird', scientific: 'Sialia sialis', common: 'Eastern Bluebird', ...over });
    const dove = (sec: number) => det({ time: T + sec * 1000, label: 'Zenaida macroura_Mourning Dove', scientific: 'Zenaida macroura', common: 'Mourning Dove' });
    // One window at a time, as the controller persists them; one Bluebird window carries an auto-clip recording id.
    for (const d of [dove(6), dove(8), dove(9), blue(15, { recordingId: 'autoclip-1', offsetSec: 0 }), blue(17, { confidence: 1 }), blue(18), blue(20)]) await recordDetections([d], GAP);
    const stored = await listDetections();
    expect(stored).toHaveLength(7); // the 60 s dedupe never drops or merges stored hits
    const sightings = await listSightings();
    expect(sightings.map((s) => [s.common, s.hits])).toEqual([
      ['Mourning Dove', 3],
      ['Eastern Bluebird', 4],
    ]);
    expect(new Set(stored.map((d) => d.sightingId)).size).toBe(2);
  });

  it('re-analysing or deleting a recording removes its sightings', async () => {
    const blob = new Blob(['x']);
    await putRecording({ id: 'r1', createdAt: 0, name: 'r', durationSec: 1, sampleRate: 48000, bytes: 1, blob, source: 'import', lat: null, lon: null, accuracy: null, summary: [], analyzedAt: null });
    await recordDetections([det({ time: 0, source: 'import', recordingId: 'r1', offsetSec: 0, sessionId: 'rec-r1' }), det({ time: 3000, source: 'import', recordingId: 'r1', offsetSec: 3, sessionId: 'rec-r1' })], GAP);
    await recordDetections([det({ time: 0 })], GAP); // a live one stays
    expect(await countSightings()).toBe(2);
    await deleteDetectionsForRecording('r1');
    expect((await listSightings()).map((s) => s.source)).toEqual(['live']);
    await recordDetections([det({ time: 0, source: 'import', recordingId: 'r1', offsetSec: 0, sessionId: 'rec-r1' })], GAP);
    await deleteRecording('r1');
    expect((await listSightings()).map((s) => s.source)).toEqual(['live']);
  });
});

describe('sightings: version-5 re-lump at the 30 s rule', () => {
  it('rebuildSightings re-lumps 60 s sightings into 30 s ones without touching the stored hits', async () => {
    const db = await getDB();
    // Hits as a 60 s rule would have stored them: one sighting spanning 0, 20 s, 45 s (gaps 20 s and 25 s) plus one at 120 s.
    const hits = [det({ time: 0 }), det({ time: 20_000, confidence: 0.9 }), det({ time: 45_000 }), det({ time: 120_000 })];
    const old = buildSightings(hits, 60_000, () => 'old');
    expect(old.sightings.map((s) => s.hits)).toEqual([3, 1]);
    const seed = db.transaction(['detections', 'sightings'], 'readwrite');
    await Promise.all([seed.objectStore('detections').clear(), seed.objectStore('sightings').clear()]); // leftovers from other tests
    for (const s of old.sightings) await seed.objectStore('sightings').put(s);
    for (const d of hits) await seed.objectStore('detections').put({ ...d, sightingId: old.assignments.get(d.id) });
    await seed.done;
    const tx = db.transaction(['detections', 'sightings'], 'readwrite');
    await rebuildSightings(tx);
    await tx.done;
    const after = await listSightings();
    // 20 s and 25 s gaps are both within 30 s: still one lump of 3; the 75 s gap splits. Same shape, now at the 30 s rule.
    expect(after.map((s) => s.hits)).toEqual([3, 1]);
    expect((await listDetections()).length).toBe(4);
    // And a 31 s gap that the 60 s rule merged is now split.
    const seed2 = db.transaction(['detections', 'sightings'], 'readwrite');
    await seed2.objectStore('detections').clear();
    for (const d of [det({ time: 0 }), det({ time: 31_000 })]) await seed2.objectStore('detections').put(d);
    await seed2.done;
    const tx2 = db.transaction(['detections', 'sightings'], 'readwrite');
    await rebuildSightings(tx2);
    await tx2.done;
    expect((await listSightings()).map((s) => s.hits)).toEqual([1, 1]);
  });
});

describe('sightings: one-time migration from DB version 2', () => {
  it('merges existing duplicate detections into sightings and links them', async () => {
    // Start from a fresh version-2 database with per-window detections only.
    const v3 = await getDB();
    v3.close();
    await deleteDB(DB_NAME);
    const v2 = await openDB(DB_NAME, 2, {
      upgrade(db) {
        const rec = db.createObjectStore('recordings', { keyPath: 'id' });
        rec.createIndex('by-created', 'createdAt');
        const d = db.createObjectStore('detections', { keyPath: 'id' });
        d.createIndex('by-time', 'time');
        d.createIndex('by-scientific', 'scientific');
        d.createIndex('by-recording', 'recordingId');
        db.createObjectStore('wiki', { keyPath: 'key' });
        db.createObjectStore('clips', { keyPath: 'scientific' });
      },
    });
    const old = [det({ time: 0, confidence: 0.5 }), det({ time: 2000, confidence: 0.9, lat: 5, lon: 6 }), det({ time: 2000 + GAP + 1, confidence: 0.6 }), det({ time: 2500, scientific: 'Parus major', common: 'Great Tit', label: 'Parus major_Great Tit' })];
    for (const d of old) await v2.put('detections', d);
    v2.close();
    // Reopen through the app's getDB (version 3): the upgrade migrates.
    const { openDB: reopen } = await import('idb');
    const migrated = await reopen(DB_NAME, 3, {
      async upgrade(db, oldVersion, _nv, tx) {
        // Same upgrade as src/storage/db.ts: re-use it by importing the module fresh is not possible (singleton), so call the shared builder.
        const { buildSightings } = await import('../src/species/sightings');
        const st = db.createObjectStore('sightings', { keyPath: 'id' });
        st.createIndex('by-scientific', 'scientific');
        st.createIndex('by-last', 'lastTime');
        st.createIndex('by-recording', 'recordingId');
        const detStore = tx.objectStore('detections');
        const all = (await detStore.getAll()) as DetectionRecord[];
        const { sightings, assignments } = buildSightings(all, GAP);
        for (const s of sightings) await st.put(s);
        for (const d of all) await detStore.put({ ...d, sightingId: assignments.get(d.id) });
        expect(oldVersion).toBe(2);
      },
    });
    const sightings = (await migrated.getAll('sightings')) as Array<{ scientific: string; hits: number; peakConfidence: number; lat: number | null }>;
    expect(sightings.map((s) => `${s.scientific}:${s.hits}:${s.peakConfidence}`).sort()).toEqual(['Parus major:1:0.7', 'Turdus merula:1:0.6', 'Turdus merula:2:0.9']);
    expect(sightings.find((s) => s.hits === 2)?.lat).toBe(5);
    const dets = (await migrated.getAll('detections')) as DetectionRecord[];
    expect(dets.every((d) => typeof d.sightingId === 'string')).toBe(true);
    migrated.close();
  });
});
