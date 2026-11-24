import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNameView, canonicalName, IDENTITY_VIEW, renamed, setCommonNames, setNameView, storedNames } from '../src/species/names';
import { groupRecordingsByBird } from '../src/species/recording-groups';

const root = path.resolve(import.meta.dirname, '..');
const table = JSON.parse(fs.readFileSync(path.join(root, 'public/models/birdnet-v3.0/v24-names.json'), 'utf8')) as Record<string, string>;
const v3Names = new Set((JSON.parse(fs.readFileSync(path.join(root, 'public/models/birdnet-v3.0/labels.json'), 'utf8')) as { classes: string[][] }).classes.map((c) => c[0]));
const v24Names = new Set((JSON.parse(fs.readFileSync(path.join(root, 'public/models/birdnet-v2.4/labels.json'), 'utf8')) as string[]).map((l) => l.split('_')[0]));

afterEach(() => {
  setNameView(IDENTITY_VIEW);
  setCommonNames(() => undefined);
});

describe('one bird, one name across the two models (DECISIONS.md #136)', () => {
  it('the table maps 297 V2.4 names, each to a species V3.0 has and V2.4 lacked', () => {
    expect(Object.keys(table)).toHaveLength(297);
    for (const [old, now] of Object.entries(table)) {
      expect(v24Names.has(old), old).toBe(true);
      expect(v3Names.has(old), `${old} is still in V3.0`).toBe(false);
      expect(v3Names.has(now), `${now} is not in V3.0`).toBe(true);
    }
    expect(table['Accipiter cooperii']).toBe('Astur cooperii');
    expect(table['Acanthis cabaret']).toBe('Acanthis flammea');
    expect(table['Acanthis hornemanni']).toBe('Acanthis flammea');
  });

  it('with V3.0 running, old names show as new and a species finds rows saved under its old names', () => {
    setNameView(buildNameView(table, true));
    expect(canonicalName('Accipiter cooperii')).toBe('Astur cooperii');
    expect(canonicalName('Turdus migratorius')).toBe('Turdus migratorius');
    expect(storedNames('Astur cooperii')).toEqual(['Astur cooperii', 'Accipiter cooperii']);
    expect(storedNames('Acanthis flammea').sort()).toEqual(['Acanthis cabaret', 'Acanthis flammea', 'Acanthis hornemanni']);
  });

  it('with V2.4 running, a rename goes back; after a merge the V3.0 name stays (V2.4 keeps the species apart)', () => {
    setNameView(buildNameView(table, false));
    expect(canonicalName('Astur cooperii')).toBe('Accipiter cooperii');
    expect(storedNames('Accipiter cooperii')).toEqual(['Accipiter cooperii', 'Astur cooperii']);
    expect(canonicalName('Acanthis flammea')).toBe('Acanthis flammea');
    expect(storedNames('Acanthis cabaret')).toEqual(['Acanthis cabaret']);
  });

  it('shows a stored row under the running name and English name, and leaves others alone', () => {
    setNameView(buildNameView(table, true));
    setCommonNames((s) => (s === 'Astur cooperii' ? 'Cooper’s Hawk' : s === 'Acanthis flammea' ? 'Redpoll' : undefined));
    expect(renamed({ scientific: 'Acanthis cabaret', common: 'Lesser Redpoll', label: 'Acanthis cabaret_Lesser Redpoll', confidence: 0.9 })).toEqual({ scientific: 'Acanthis flammea', common: 'Redpoll', label: 'Acanthis flammea_Redpoll', confidence: 0.9 });
    const row = { scientific: 'Turdus migratorius', common: 'American Robin' };
    expect(renamed(row)).toBe(row);
  });

  it('groups recordings of one bird saved with either model together', () => {
    setNameView(buildNameView(table, true));
    setCommonNames((s) => (s === 'Astur cooperii' ? 'Cooper’s Hawk' : undefined));
    const rec = (id: string, scientific: string, createdAt: number) => ({ id, createdAt, summary: [{ scientific, common: 'Cooper’s Hawk', maxConfidence: 0.8, windows: 1 }] });
    const groups = groupRecordingsByBird([rec('a', 'Accipiter cooperii', 1), rec('b', 'Astur cooperii', 2)] as never);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ scientific: 'Astur cooperii', recordings: [{ id: 'b' }, { id: 'a' }] });
  });

  it('changes nothing until a table is loaded', () => {
    expect(canonicalName('Accipiter cooperii')).toBe('Accipiter cooperii');
    expect(storedNames('Astur cooperii')).toEqual(['Astur cooperii']);
  });
});

describe('saved data under either name (DECISIONS.md #136)', () => {
  it('lists, finds and ticks a bird saved under both names as one, and nothing stored changes', async () => {
    const { clearAllData, getClipMeta, listClips, listSightedSpecies, listSightings, listSightingsForSpecies, putClip, recordDetections, getDB } = await import('../src/storage/db');
    await clearAllData();
    const det = (id: string, scientific: string, time: number) => ({ id, time, label: `${scientific}_Cooper’s Hawk`, scientific, common: 'Cooper’s Hawk', confidence: 0.8, lat: null, lon: null, accuracy: null, recordingId: null, offsetSec: null, source: 'live' as const, sessionId: 's' });
    await recordDetections([det('d1', 'Accipiter cooperii', 1_000)]);
    await recordDetections([det('d2', 'Astur cooperii', 10_000_000)]);
    const clip = (scientific: string, confidence: number) => ({ scientific, common: 'Cooper’s Hawk', blob: new Blob([new Uint8Array(8)]), sampleRate: 48000, durationSec: 3, confidence, time: 1, savedAt: 1, lat: null, lon: null, accuracy: null, source: 'live' as const, recordingId: null });
    await putClip(clip('Accipiter cooperii', 0.9) as never);
    await putClip(clip('Astur cooperii', 0.7) as never);

    setNameView(buildNameView(table, true));
    setCommonNames((s) => (s === 'Astur cooperii' ? 'Cooper’s Hawk' : undefined));
    expect(await listSightedSpecies()).toEqual(['Astur cooperii']);
    expect((await listSightings()).map((s) => s.scientific)).toEqual(['Astur cooperii', 'Astur cooperii']);
    expect((await listSightingsForSpecies('Astur cooperii')).map((s) => s.firstTime)).toEqual([1_000, 10_000_000]);
    // The more confident clip, whichever name it was saved under.
    expect(await getClipMeta('Astur cooperii')).toMatchObject({ scientific: 'Astur cooperii', confidence: 0.9 });
    expect((await listClips()).map((c) => [c.scientific, c.confidence])).toEqual([['Astur cooperii', 0.9]]);

    // V2.4 again: the same rows under its name.
    setNameView(buildNameView(table, false));
    expect(await listSightedSpecies()).toEqual(['Accipiter cooperii']);
    expect(await listSightingsForSpecies('Accipiter cooperii')).toHaveLength(2);

    // Stored rows keep the name they were saved under.
    const stored = await (await getDB()).getAll('sightings');
    expect(stored.map((s) => s.scientific).sort()).toEqual(['Accipiter cooperii', 'Astur cooperii']);
    await clearAllData();
  });
});
