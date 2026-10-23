import { beforeEach, describe, expect, it } from 'vitest';
import { buildOverpassQuery, cellsFor, classifyPlace, distanceToPlace, groupByPlace, parseOverpass, PLACE_FILTERS, roundCell, type Cell, type NaturePlace } from '../src/geo/places';
import { isFresh, lookupPlaces, OVERPASS_URL, PLACES_TTL_MS, placesCacheKey, resetPlaceLookupState, type PlaceCache } from '../src/geo/place-lookup';
import type { WikiCacheEntry } from '../src/storage/types';

const park: NaturePlace = { id: 'way/1', name: 'Saylorville Park', kind: 'park', lat: 41.7, lon: -93.7, bbox: [41.698, -93.703, 41.702, -93.697] };
const garden: NaturePlace = { id: 'way/2', name: 'Rose Botanical Garden', kind: 'garden', lat: 41.7, lon: -93.7, bbox: [41.6995, -93.7005, 41.7005, -93.6995] };
const trail: NaturePlace = { id: 'node/3', name: 'Neal Smith Trail', kind: 'trail', lat: 41.72, lon: -93.72 };
const s = (id: string, lat: number | null, lon: number | null, scientific = 'Poecile atricapillus', lastTime = 1) => ({ id, lat, lon, scientific, lastTime });

describe('rounding (about 100 m)', () => {
  it('rounds to 3 decimals and keys cells by the rounded position', () => {
    expect(roundCell(41.67349, -93.69851)).toEqual({ key: '41.673,-93.699', lat: 41.673, lon: -93.699 });
    expect(roundCell(-0.0001, 0.0002).key).toBe('0.000,0.000'); // no "-0.000"
  });
  it('dedupes points in the same cell and skips points without a position', () => {
    const cells = cellsFor([
      { lat: 41.67301, lon: -93.69849 },
      { lat: 41.67304, lon: -93.69841 },
      { lat: null, lon: null },
      { lat: 41.7, lon: -93.7 },
    ]);
    expect(cells.map((c) => c.key)).toEqual(['41.673,-93.698', '41.700,-93.700']);
  });
});

describe('buildOverpassQuery', () => {
  const cells: Cell[] = [roundCell(41.673, -93.698), roundCell(41.7, -93.7)];
  const q = buildOverpassQuery(cells);

  it('is one JSON request with a 15 s server timeout, around:500 per cell, no exact positions', () => {
    expect(q.startsWith('[out:json][timeout:15];')).toBe(true);
    expect(q).toContain('(around:500,41.673,-93.698)');
    expect(q).toContain('(around:500,41.700,-93.700)');
    // Every coordinate in the query has exactly 3 decimals.
    for (const m of q.matchAll(/around:500,([-\d.]+),([-\d.]+)\)/g)) {
      expect(m[1]).toMatch(/^-?\d+\.\d{3}$/);
      expect(m[2]).toMatch(/^-?\d+\.\d{3}$/);
    }
    expect(q.match(/->\.c\d+;/g)).toHaveLength(2);
    expect(q.match(/out count;/g)).toHaveLength(3);
  });

  it('asks only for the allowed nature tags, each with a name, and never for shops, amenities or tourism', () => {
    const keys = Array.from(q.matchAll(/\["([^"]+)"/g)).map((m) => m[1]);
    expect(new Set(keys)).toEqual(new Set(['leisure', 'garden:type', 'name', 'boundary', 'landuse', 'natural', 'highway', 'route']));
    for (const banned of ['shop', 'amenity', 'tourism', 'craft', 'office', 'building', 'recreation_ground', 'hotel', 'fuel', 'restaurant', 'bar']) expect(q).not.toContain(banned);
    for (const f of PLACE_FILTERS) expect(f).toContain('["name"');
    expect(q).toContain('"^(park|nature_reserve)$"');
    expect(q).toContain('["garden:type"="botanical"]');
    expect(q).toContain('"^(path|footway|track)$"');
    expect(q).toContain('"^(hiking|foot)$"');
  });
});

describe('classifyPlace', () => {
  it('keeps nature places with a name and drops everything else', () => {
    expect(classifyPlace({ leisure: 'park', name: 'Jester Park' })).toBe('park');
    expect(classifyPlace({ leisure: 'nature_reserve', name: 'Chichaqua' })).toBe('reserve');
    expect(classifyPlace({ boundary: 'protected_area', name: 'X' })).toBe('reserve');
    expect(classifyPlace({ leisure: 'garden', 'garden:type': 'botanical', name: 'Greater Des Moines' })).toBe('garden');
    expect(classifyPlace({ leisure: 'garden', name: 'Reiman Botanic Gardens' })).toBe('garden');
    expect(classifyPlace({ leisure: 'garden', name: 'Smith Family Garden' })).toBeNull();
    expect(classifyPlace({ natural: 'wood', name: 'Ledges Woods' })).toBe('wood');
    expect(classifyPlace({ highway: 'path', name: 'Neal Smith Trail' })).toBe('trail');
    expect(classifyPlace({ route: 'hiking', name: 'High Trestle' })).toBe('trail');
    expect(classifyPlace({ leisure: 'park' })).toBeNull();
    expect(classifyPlace({ shop: 'mall', name: 'Jordan Creek Town Center' })).toBeNull();
    expect(classifyPlace({ amenity: 'fuel', name: 'Casey’s' })).toBeNull();
    expect(classifyPlace({ amenity: 'bar', name: 'The Park Bar' })).toBeNull();
    expect(classifyPlace({ leisure: 'recreation_ground', name: 'Ball fields' })).toBeNull();
    expect(classifyPlace({ highway: 'residential', name: 'Park Ave' })).toBeNull();
  });
});

describe('parseOverpass', () => {
  const cells = [roundCell(41.7, -93.7), roundCell(41.8, -93.6)];
  const json = {
    elements: [
      { type: 'count', id: 0, tags: { total: '2' } },
      { type: 'way', id: 1 },
      { type: 'node', id: 9 },
      { type: 'count', id: 0, tags: { total: '0' } },
      { type: 'count', id: 0, tags: { total: '2' } },
      { type: 'node', id: 9, lat: 41.701, lon: -93.701, tags: { amenity: 'restaurant', name: 'Should never be used' } },
      { type: 'way', id: 1, bounds: { minlat: 41.698, minlon: -93.703, maxlat: 41.702, maxlon: -93.697 }, tags: { leisure: 'park', name: 'Saylorville Park' } },
    ],
  };
  it('splits the answer per cell at the count markers and drops anything that is not a nature place', () => {
    const out = parseOverpass(json, cells);
    expect(out.get(cells[0].key)).toEqual([{ id: 'way/1', name: 'Saylorville Park', kind: 'park', lat: 41.7, lon: -93.7, bbox: [41.698, -93.703, 41.702, -93.697] }]);
    expect(out.get(cells[1].key)).toEqual([]);
  });
  it('offers every place to every cell when the markers are missing', () => {
    const out = parseOverpass({ elements: json.elements.filter((e) => e.type !== 'count') }, cells);
    expect(out.get(cells[1].key)?.map((p) => p.id)).toEqual(['way/1']);
  });
});

describe('groupByPlace', () => {
  it('puts each sighting with its nearest place within 500 m, the more specific place on a tie', () => {
    const sightings = [s('a', 41.7, -93.7, 'A', 3), s('b', 41.7015, -93.6985, 'B', 2), s('c', 41.7201, -93.7201, 'A', 1), s('d', 41.75, -93.75, 'C', 5), s('e', null, null)];
    const g = groupByPlace(sightings, [park, garden, trail], 500);
    // a is inside both boxes: the garden (smaller) wins; b is only inside the park.
    expect(g.groups.map((x) => [x.place.name, x.sightings.map((y) => y.id)])).toEqual([
      ['Neal Smith Trail', ['c']],
      ['Rose Botanical Garden', ['a']],
      ['Saylorville Park', ['b']],
    ]);
    expect(g.other.map((x) => x.id)).toEqual(['d']);
    expect(g.unknown).toEqual([]);
  });

  it('respects the 500 m limit (distance to the box edge, or to the node)', () => {
    expect(distanceToPlace(41.7, -93.7, park)).toBe(0);
    const north = 41.702 + 450 / 111_195; // 450 m north of the box
    expect(distanceToPlace(north, -93.7, park)).toBeCloseTo(450, 0);
    expect(groupByPlace([s('x', north, -93.7)], [park], 500).groups).toHaveLength(1);
    const far = 41.702 + 550 / 111_195;
    expect(groupByPlace([s('x', far, -93.7)], [park], 500).other).toHaveLength(1);
  });

  it('keeps sightings whose cell was not looked up apart, and counts species most-seen first', () => {
    const g = groupByPlace([s('a', 41.7, -93.7, 'A'), s('b', 41.7, -93.7, 'B', 9), s('c', 41.7, -93.7, 'B', 1), s('d', 10, 10)], (x) => (x.lat === 10 ? undefined : [park]));
    expect(g.unknown.map((x) => x.id)).toEqual(['d']);
    expect(g.groups[0].species).toEqual(['B', 'A']);
  });
});

describe('lookupPlaces (cache, expiry, busy, offline)', () => {
  beforeEach(() => resetPlaceLookupState());

  const memCache = () => {
    const m = new Map<string, WikiCacheEntry>();
    const cache: PlaceCache = { get: async (k) => m.get(k), put: async (e) => void m.set(e.key, e) };
    return { m, cache };
  };
  const answer = (cells: number) => ({ elements: [...Array.from({ length: cells }, () => ({ type: 'count', id: 0 })), { type: 'count', id: 0 }] });

  it('isFresh: under 30 days only', () => {
    expect(isFresh({ key: 'k', fetchedAt: 0, data: null }, PLACES_TTL_MS - 1)).toBe(true);
    expect(isFresh({ key: 'k', fetchedAt: 0, data: null }, PLACES_TTL_MS)).toBe(false);
    expect(isFresh(undefined, 0)).toBe(false);
  });

  it('POSTs one form-encoded query to the main instance, caches each cell, and reuses the cache for 30 days', async () => {
    const { m, cache } = memCache();
    const calls: Array<{ url: string; body: string }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify(answer(2)), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let now = 1_000;
    const pts = [{ lat: 41.70001, lon: -93.70001 }, { lat: 41.8, lon: -93.6 }, { lat: 41.70002, lon: -93.70002 }];
    const r = await lookupPlaces(pts, { fetch, cache, now: () => now, online: () => true });
    expect(r.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OVERPASS_URL);
    expect(calls[0].body.startsWith('data=')).toBe(true);
    expect(decodeURIComponent(calls[0].body.slice(5))).toContain('around:500,41.700,-93.700');
    expect(decodeURIComponent(calls[0].body)).not.toContain('41.70001');
    expect(m.has(placesCacheKey(roundCell(41.7, -93.7)))).toBe(true);
    // Within 30 days: no request.
    now += PLACES_TTL_MS - 10;
    await lookupPlaces(pts, { fetch, cache, now: () => now, online: () => true });
    expect(calls).toHaveLength(1);
    // After 30 days: refreshed.
    now += 20;
    await lookupPlaces(pts, { fetch, cache, now: () => now, online: () => true });
    expect(calls).toHaveLength(2);
  });

  it('on 429 keeps the cached places, says busy and waits 30 s before asking again', async () => {
    const { m, cache } = memCache();
    const cell = roundCell(41.7, -93.7);
    m.set(placesCacheKey(cell), { key: placesCacheKey(cell), fetchedAt: 0, data: { places: [park] } });
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('', { status: 429 });
    }) as unknown as typeof globalThis.fetch;
    let now = PLACES_TTL_MS + 5; // stale
    const r = await lookupPlaces([{ lat: 41.7, lon: -93.7 }], { fetch, cache, now: () => now, online: () => true });
    expect(r.status).toBe('busy');
    expect(r.byCell.get(cell.key)).toEqual([park]);
    now += 10_000;
    expect((await lookupPlaces([{ lat: 41.7, lon: -93.7 }], { fetch, cache, now: () => now, online: () => true })).status).toBe('busy');
    expect(calls).toBe(1);
    now += 30_000;
    await lookupPlaces([{ lat: 41.7, lon: -93.7 }], { fetch, cache, now: () => now, online: () => true });
    expect(calls).toBe(2);
  });

  it('504 and a timeout are busy; offline sends nothing', async () => {
    const { cache } = memCache();
    const f504 = (async () => new Response('', { status: 504 })) as unknown as typeof globalThis.fetch;
    expect((await lookupPlaces([{ lat: 1, lon: 1 }], { fetch: f504, cache, online: () => true })).status).toBe('busy');
    resetPlaceLookupState();
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof globalThis.fetch;
    expect((await lookupPlaces([{ lat: 1, lon: 1 }], { fetch: hang, cache, online: () => true, timeoutMs: 20 })).status).toBe('busy');
    resetPlaceLookupState();
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof globalThis.fetch;
    const r = await lookupPlaces([{ lat: 1, lon: 1 }], { fetch: spy, cache, online: () => false });
    expect(r.status).toBe('offline');
    expect(r.byCell.size).toBe(0);
    expect(called).toBe(false);
  });
});
