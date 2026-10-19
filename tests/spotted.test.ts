import { beforeEach, describe, expect, it } from 'vitest';
import type { Species } from '../src/model/labels';
import { countSpotted, filterSpotted, isSpotted, loadSpottedSet, spottedSet } from '../src/species/spotted';
import { getDB, listSightedSpecies, recordDetections } from '../src/storage/db';
import type { DetectionRecord } from '../src/storage/types';

let n = 0;
const det = (scientific: string, over: Partial<DetectionRecord> = {}): DetectionRecord => ({
  id: `d${++n}`,
  time: n * 1000,
  label: `${scientific}_${scientific}`,
  scientific,
  common: scientific,
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
const sp = (index: number, scientific: string): Species => ({ index, label: `${scientific}_${scientific}`, scientific, common: scientific, isBird: true });

describe('spotted species: set from IndexedDB sightings', () => {
  beforeEach(async () => {
    const db = await getDB();
    const tx = db.transaction(['detections', 'sightings'], 'readwrite');
    await Promise.all([tx.objectStore('detections').clear(), tx.objectStore('sightings').clear()]);
    await tx.done;
  });

  it('is empty before any sighting', async () => {
    expect(await listSightedSpecies()).toEqual([]);
    expect((await loadSpottedSet()).size).toBe(0);
  });

  it('lists each sighted species once, however many sightings or windows it has', async () => {
    await recordDetections([det('Turdus merula'), det('Turdus merula'), det('Parus major')], 60_000);
    // A second, separate sighting of the blackbird (outside the gap) must not duplicate the key.
    await recordDetections([det('Turdus merula', { time: 10 * 60_000 })], 60_000);
    expect((await listSightedSpecies()).sort()).toEqual(['Parus major', 'Turdus merula']);
    const set = await loadSpottedSet();
    expect(set.size).toBe(2);
    expect(isSpotted(sp(0, 'Turdus merula'), set)).toBe(true);
    expect(isSpotted(sp(1, 'Erithacus rubecula'), set)).toBe(false);
  });
});

describe('spotted species: "Spotted by me" filter', () => {
  const all = [sp(0, 'Turdus merula'), sp(1, 'Parus major'), sp(2, 'Erithacus rubecula')];
  const spotted = spottedSet(['Parus major', 'Erithacus rubecula', '']);

  it('spottedSet drops empty names', () => {
    expect(spotted.size).toBe(2);
  });
  it('off: the list is returned unchanged (as a copy)', () => {
    const out = filterSpotted(all, spotted, false);
    expect(out).toEqual(all);
    expect(out).not.toBe(all);
  });
  it('on: keeps only species with a sighting, in list order', () => {
    expect(filterSpotted(all, spotted, true).map((s) => s.scientific)).toEqual(['Parus major', 'Erithacus rubecula']);
    expect(filterSpotted(all, new Set(), true)).toEqual([]);
  });
  it('countSpotted counts the ticks the list will show', () => {
    expect(countSpotted(all, spotted)).toBe(2);
    expect(countSpotted([], spotted)).toBe(0);
  });
});
