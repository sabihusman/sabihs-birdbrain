import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllData, deleteRecording, getClipMeta, getRecordingMeta, listDetections, listSightedSpecies, listSightings, putClip, putRecording, recordDetections, removeListenBirds, removeSpecies } from '../src/storage/db';
import type { DetectionRecord, RecordingRecord } from '../src/storage/types';
import { DEFAULT_SIGHTING_GAP_SECONDS } from '../src/species/sightings';

/** "Remove from my birds" and "also remove that listen's birds" (DECISIONS.md #138). */

const GAP = DEFAULT_SIGHTING_GAP_SECONDS * 1000;
let n = 0;
const bird = (scientific: string, common: string) => (over: Partial<DetectionRecord> = {}): DetectionRecord => ({
  id: `d${++n}`,
  time: 0,
  label: `${scientific}_${common}`,
  scientific,
  common,
  confidence: 0.8,
  lat: null,
  lon: null,
  accuracy: null,
  recordingId: null,
  offsetSec: null,
  source: 'live',
  sessionId: 'listen-1',
  ...over,
});
const cardinal = bird('Cardinalis cardinalis', 'Northern Cardinal');
const robin = bird('Turdus migratorius', 'American Robin');

const rec = (id: string, source: RecordingRecord['source']): RecordingRecord => ({ id, createdAt: 0, name: id, durationSec: 3, sampleRate: 48000, bytes: 1, blob: new Blob(['x']), source, lat: null, lon: null, accuracy: null, summary: [], analyzedAt: 0 });
const clip = (scientific: string, time: number) => ({ scientific, common: scientific, blob: new Blob(['c']), sampleRate: 48000, durationSec: 3, confidence: 0.9, time, savedAt: time, lat: null, lon: null, accuracy: null, source: 'live' as const, recordingId: null });

beforeEach(async () => {
  await clearAllData();
});

describe('Remove from my birds', () => {
  it('takes every window, sighting, auto-saved clip and sound clip of the bird; other birds and hand-made recordings stay', async () => {
    await putRecording(rec('auto-c', 'autoclip'));
    await putRecording(rec('auto-mixed', 'autoclip'));
    await putRecording(rec('mine', 'mic'));
    await recordDetections([cardinal({ time: 0, recordingId: 'auto-c', offsetSec: 0 }), cardinal({ time: 3000 })], GAP);
    await recordDetections([cardinal({ time: 200_000, recordingId: 'auto-mixed', offsetSec: 0 }), robin({ time: 200_000, recordingId: 'auto-mixed', offsetSec: 0 })], GAP);
    await recordDetections([cardinal({ time: 900_000, source: 'recording', recordingId: 'mine', offsetSec: 0, sessionId: 'rec-mine' })], GAP);
    await putClip(clip('Cardinalis cardinalis', 0));
    await putClip(clip('Turdus migratorius', 200_000));

    const plan = await removeSpecies('Cardinalis cardinalis', true);
    expect(plan).toMatchObject({ birds: ['Cardinalis cardinalis'], detections: 4, sightings: 3, autoClips: ['auto-c'], speciesClips: ['Cardinalis cardinalis'] });
    // A count changes nothing.
    expect(await listSightedSpecies()).toContain('Cardinalis cardinalis');

    await removeSpecies('Cardinalis cardinalis');
    expect(await listSightedSpecies()).toEqual(['Turdus migratorius']);
    expect((await listDetections()).map((d) => d.scientific)).toEqual(['Turdus migratorius']);
    expect(await getRecordingMeta('auto-c')).toBeUndefined();
    expect(await getRecordingMeta('auto-mixed')).toBeDefined(); // the robin is still in it
    expect(await getRecordingMeta('mine')).toBeDefined(); // recordings made by hand are never removed
    expect(await getClipMeta('Cardinalis cardinalis')).toBeUndefined();
    expect(await getClipMeta('Turdus migratorius')).toBeDefined();
  });
});

describe('Deleting a recording, and the listen it came from', () => {
  it('deleting an auto-saved clip keeps the rest of its live sighting, re-counted, instead of leaving windows without a sighting', async () => {
    await putRecording(rec('auto-c', 'autoclip'));
    await recordDetections([cardinal({ time: 0 }), cardinal({ time: 3000, confidence: 0.95, recordingId: 'auto-c', offsetSec: 0 }), cardinal({ time: 6000 })], GAP);
    await deleteRecording('auto-c');
    const [s] = await listSightings();
    expect(s).toMatchObject({ hits: 2, peakConfidence: 0.8, recordingId: null });
    const dets = await listDetections();
    expect(dets).toHaveLength(2);
    expect(dets.every((d) => d.sightingId === s.id)).toBe(true);
  });

  it('offers the same birds from that listen: other windows, sightings and auto-saved clips; other birds and other listens stay', async () => {
    await putRecording(rec('auto-1', 'autoclip'));
    await putRecording(rec('auto-2', 'autoclip'));
    await recordDetections([cardinal({ time: 0, recordingId: 'auto-1', offsetSec: 0 })], GAP);
    await recordDetections([cardinal({ time: 3000 })], GAP);
    await recordDetections([cardinal({ time: 120_000, recordingId: 'auto-2', offsetSec: 0 })], GAP);
    await recordDetections([robin({ time: 6000 })], GAP);
    await recordDetections([cardinal({ time: 900_000, sessionId: 'listen-2' })], GAP);
    await putClip(clip('Cardinalis cardinalis', 120_000));

    const plan = await removeListenBirds('auto-1', true);
    expect(plan).toMatchObject({ birds: ['Cardinalis cardinalis'], detections: 2, sightings: 1, autoClips: ['auto-2'], speciesClips: ['Cardinalis cardinalis'] });

    await removeListenBirds('auto-1');
    await deleteRecording('auto-1');
    const left = await listDetections();
    expect(left.map((d) => [d.common, d.sessionId])).toEqual([
      ['American Robin', 'listen-1'],
      ['Northern Cardinal', 'listen-2'],
    ]);
    expect(await getRecordingMeta('auto-2')).toBeUndefined();
    expect(await getClipMeta('Cardinalis cardinalis')).toBeUndefined();
    expect((await listSightings()).map((s) => s.common).sort((a, b) => a.localeCompare(b))).toEqual(['American Robin', 'Northern Cardinal']);
  });

  it('has nothing more to offer for a recording made or imported on its own', async () => {
    await putRecording(rec('imp', 'import'));
    await recordDetections([cardinal({ time: 0, source: 'import', recordingId: 'imp', offsetSec: 0, sessionId: 'rec-imp' })], GAP);
    await recordDetections([cardinal({ time: 3000 })], GAP);
    expect(await removeListenBirds('imp', true)).toMatchObject({ detections: 0, sightings: 0, autoClips: [], speciesClips: [] });
  });
});

describe('the questions', () => {
  it('count what goes, in plain words', async () => {
    const { speciesRemovalText, listenRemovalText, listNames } = await import('../src/ui/remove-birds-text');
    const plan = { birds: ['Cardinalis cardinalis'], detections: 14, sightings: 3, autoClips: ['a', 'b'], speciesClips: ['Cardinalis cardinalis'] };
    expect(speciesRemovalText('Northern Cardinal', plan).lines[0]).toBe('Takes away 3 sightings and 2 auto-saved clips and its sound clip on this phone, for example after a bird video played nearby.');
    expect(speciesRemovalText('Northern Cardinal', { ...plan, sightings: 1, autoClips: [], speciesClips: [] }).lines[0]).toBe('Takes away 1 sighting on this phone, for example after a bird video played nearby.');
    const listen = listenRemovalText(plan, ['Northern Cardinal', 'Blue Jay']);
    expect(listen.lines[0]).toBe('The same listen heard the Northern Cardinal and Blue Jay 14 more times, with 2 auto-saved clips and a sound clip.');
    expect(listen.both).toBe('Delete it and the rest of that listen’s Northern Cardinal and Blue Jay');
    expect(listenRemovalText({ ...plan, detections: 1, autoClips: [], speciesClips: [] }, ['Northern Cardinal']).lines[0]).toBe('The same listen heard the Northern Cardinal 1 more time.');
    expect(listNames(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
