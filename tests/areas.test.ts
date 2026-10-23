import { describe, expect, it } from 'vitest';
import { AREA_SPACING_M, groupIntoAreas, haversine, roundCell } from '../src/geo/areas';

/** Metres north of a latitude, in degrees. */
const north = (m: number) => m / 111_195;
const s = (id: string, lat: number | null, lon: number | null, t: number, scientific = 'Poecile atricapillus') => ({ id, lat, lon, scientific, firstTime: t, lastTime: t });

describe('groupIntoAreas (1 km-diameter areas, DECISIONS.md #73)', () => {
  it('two sightings 300 m apart are one area, centred on the older one', () => {
    const areas = groupIntoAreas([s('b', 41.7 + north(300), -93.7, 2), s('a', 41.7, -93.7, 1)]);
    expect(areas).toHaveLength(1);
    expect(areas[0].lat).toBe(41.7);
    expect(areas[0].key).toBe('41.700,-93.700');
    expect(areas[0].sightings.map((x) => x.id)).toEqual(['b', 'a']); // newest first
  });

  it('two sightings 1.2 km apart are two areas', () => {
    const areas = groupIntoAreas([s('a', 41.7, -93.7, 1), s('b', 41.7 + north(1200), -93.7, 2)]);
    expect(areas).toHaveLength(2);
  });

  it('a sighting 700 m from a centre joins that area (the edge rule), so no new centre is closer than 1 km', () => {
    const areas = groupIntoAreas([s('a', 41.7, -93.7, 1), s('b', 41.7 + north(700), -93.7, 2)]);
    expect(areas).toHaveLength(1);
    expect(areas[0].sightings.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('joins the nearest centre when two are in reach', () => {
    const areas = groupIntoAreas([s('a', 41.7, -93.7, 1), s('b', 41.7 + north(1500), -93.7, 2), s('c', 41.7 + north(900), -93.7, 3)]);
    const withC = areas.find((x) => x.sightings.some((y) => y.id === 'c'))!;
    expect(withC.sightings.map((y) => y.id).sort()).toEqual(['b', 'c']);
  });

  it('keeps every two centres at least 1 km apart (random sightings)', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pts = Array.from({ length: 300 }, (_, i) => s(`p${i}`, 41.7 + (rand() - 0.5) * 0.06, -93.7 + (rand() - 0.5) * 0.08, i));
    const areas = groupIntoAreas(pts);
    expect(areas.length).toBeGreaterThan(5);
    for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) expect(haversine(areas[i].lat, areas[i].lon, areas[j].lat, areas[j].lon)).toBeGreaterThanOrEqual(AREA_SPACING_M);
    expect(areas.reduce((n, a) => n + a.sightings.length, 0)).toBe(300);
    // Keys are unique, so a name can never belong to two areas.
    expect(new Set(areas.map((a) => a.key)).size).toBe(areas.length);
  });

  it('is stable: a newer sighting never moves the existing areas', () => {
    const base = [s('a', 41.7, -93.7, 1), s('b', 41.7 + north(1200), -93.7, 2), s('c', 41.7 + north(400), -93.7, 3)];
    const before = groupIntoAreas(base).map((a) => a.key).sort();
    const after = groupIntoAreas([...base, s('d', 41.7 + north(600), -93.7, 4), s('e', 41.7 + north(5000), -93.7, 5)]);
    for (const k of before) expect(after.map((a) => a.key)).toContain(k);
    expect(after).toHaveLength(3);
  });

  it('skips sightings without a position, orders by sightings then newest, and counts species most seen first', () => {
    const areas = groupIntoAreas([s('x', null, null, 0), s('a', 41.7, -93.7, 1, 'A'), s('b', 41.7, -93.7, 2, 'B'), s('c', 41.7, -93.7, 3, 'B'), s('far', 42, -93, 9)]);
    expect(areas.map((a) => a.sightings.length)).toEqual([3, 1]);
    expect(areas[0].species).toEqual(['B', 'A']);
  });
});

describe('roundCell', () => {
  it('rounds to 3 decimals, never "-0.000"', () => {
    expect(roundCell(41.67349, -93.69851)).toEqual({ key: '41.673,-93.699', lat: 41.673, lon: -93.699 });
    expect(roundCell(-0.0001, 0.0002).key).toBe('0.000,0.000');
  });
});
