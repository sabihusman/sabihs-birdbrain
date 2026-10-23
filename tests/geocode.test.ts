import { afterEach, describe, expect, it, vi } from 'vitest';
import { roundCell } from '../src/geo/areas';
import { createGeocoder, DEFAULT_GEOCODER_URL, failureStatus, formatNear, GEOCODE_TTL_MS, geocodeCacheKey, GEOCODER_URL, MIN_INTERVAL_MS, placeLabel, reverseUrl, type GeocodeCache } from '../src/geo/geocode';
import type { WikiCacheEntry } from '../src/storage/types';

// Nominatim jsonv2 answers. The road and the "Unable to geocode" ones were seen live on 2026-10-23
// (lat 41.672, lon -93.698 and the open Pacific); the park is the same shape with category leisure.
const ROAD = { place_id: 374370335, osm_type: 'way', category: 'highway', type: 'secondary', addresstype: 'secondary', name: 'Merle Hay Road', display_name: 'Merle Hay Road, Johnston, Polk County, Iowa, 50131, United States', address: { road: 'Merle Hay Road', town: 'Johnston', county: 'Polk County', state: 'Iowa', 'ISO3166-2-lvl4': 'US-IA', postcode: '50131', country: 'United States', country_code: 'us' } };
const PARK = { osm_type: 'way', category: 'leisure', type: 'park', addresstype: 'leisure', name: 'Jester Park', display_name: 'Jester Park, Northwest 118th Avenue, Granger, Polk County, Iowa, 50109, United States', address: { leisure: 'Jester Park', road: 'Northwest 118th Avenue', city: 'Granger', county: 'Polk County', state: 'Iowa', country: 'United States' } };
const UNNAMED_HOUSE = { category: 'building', type: 'house', name: '', address: { house_number: '5', road: 'Bendelow Court', town: 'Johnston', state: 'Iowa' } };
const SUBURB_ONLY = { category: 'place', type: 'suburb', address: { suburb: 'Beaverdale', city: 'Des Moines', state: 'Iowa' } };
// Seen live at 41.766,-93.777: an empty name, no road, only a subdivision and a township.
const SUBDIVISION = { category: 'highway', type: 'residential', name: '', address: { residential: 'Jester Glen Estates', municipality: 'Jefferson Township', county: 'Polk County', state: 'Iowa', country: 'United States' } };
const NOTHING = { error: 'Unable to geocode' };

describe('placeLabel', () => {
  it('a park: its name, then city and state', () => {
    expect(placeLabel(PARK)).toEqual({ name: 'Jester Park', line2: 'Granger, Iowa' });
  });
  it('a road: its name, then town and state', () => {
    expect(placeLabel(ROAD)).toEqual({ name: 'Merle Hay Road', line2: 'Johnston, Iowa' });
  });
  it('falls back to the road, then the suburb, and never repeats the title', () => {
    expect(placeLabel(UNNAMED_HOUSE)).toEqual({ name: 'Bendelow Court', line2: 'Johnston, Iowa' });
    expect(placeLabel(SUBURB_ONLY)).toEqual({ name: 'Beaverdale', line2: 'Des Moines, Iowa' });
    expect(placeLabel(SUBDIVISION)).toEqual({ name: 'Jester Glen Estates', line2: 'Jefferson Township, Iowa' });
    expect(placeLabel({ address: { town: 'Johnston', state: 'Iowa' } })).toEqual({ name: 'Johnston', line2: 'Iowa' });
  });
  it('no name at all is null', () => {
    expect(placeLabel(NOTHING)).toBeNull();
    expect(placeLabel(null)).toBeNull();
  });
});

describe('request and wording', () => {
  it('asks Nominatim reverse at zoom 17 with the centre to 3 decimals; one constant switches the service', () => {
    expect(GEOCODER_URL).toBe(DEFAULT_GEOCODER_URL);
    expect(reverseUrl(roundCell(41.67249, -93.6981))).toBe('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=41.672&lon=-93.698&zoom=17&addressdetails=1');
    expect(reverseUrl(roundCell(1, 2), 'https://geo.example.org')).toMatch(/^https:\/\/geo\.example\.org\/reverse\?/);
  });
  it('"Near 41.672, −93.698" with a real minus sign', () => {
    expect(formatNear(roundCell(41.672, -93.698))).toBe('Near 41.672, −93.698');
  });
  it('a failure is busy while online and offline only when the phone says so', () => {
    expect(failureStatus(true)).toBe('busy');
    expect(failureStatus(false)).toBe('offline');
  });
});

const memCache = () => {
  const m = new Map<string, WikiCacheEntry>();
  const cache: GeocodeCache = { get: async (k) => m.get(k), put: async (e) => void m.set(e.key, e) };
  return { m, cache };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('createGeocoder', () => {
  afterEach(() => vi.useRealTimers());

  it('spaces requests at least 1.1 s apart, one at a time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const sentAt: number[] = [];
    const fetch = (async () => {
      sentAt.push(Date.now());
      return json(ROAD);
    }) as unknown as typeof globalThis.fetch;
    const g = createGeocoder({ fetch, cache: memCache().cache, online: () => true });
    const all = Promise.all([g.lookup(roundCell(41.7, -93.7)), g.lookup(roundCell(41.8, -93.7)), g.lookup(roundCell(41.9, -93.7))]);
    await vi.advanceTimersByTimeAsync(5000);
    const results = await all;
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(sentAt).toHaveLength(3);
    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    expect(sentAt[2] - sentAt[1]).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    expect(sentAt[0]).toBe(1_000_000); // the first one does not wait
  });

  it('caches every answer (incl. "no name") for 180 days and a cache hit sends nothing', async () => {
    const { m, cache } = memCache();
    let now = 5_000;
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return json(url.includes('lat=0.000') ? NOTHING : PARK);
    }) as unknown as typeof globalThis.fetch;
    const g = createGeocoder({ fetch, cache, online: () => true, now: () => now, sleep: async () => {} });
    const park = roundCell(41.7, -93.7);
    expect(await g.lookup(park)).toEqual({ status: 'ok', label: { name: 'Jester Park', line2: 'Granger, Iowa' } });
    expect(m.get(geocodeCacheKey(park))?.data).toEqual({ label: { name: 'Jester Park', line2: 'Granger, Iowa' } });
    expect(await g.lookup(roundCell(0, -140))).toEqual({ status: 'ok', label: null });
    expect(urls).toHaveLength(2);
    // Hits: no request.
    await g.lookup(park);
    await g.lookup(roundCell(0, -140));
    expect(urls).toHaveLength(2);
    expect(await g.cached(park)).toEqual({ label: { name: 'Jester Park', line2: 'Granger, Iowa' }, fresh: true });
    // After 180 days: still shown, but asked again.
    now += GEOCODE_TTL_MS;
    expect((await g.cached(park))?.fresh).toBe(false);
    await g.lookup(park);
    expect(urls).toHaveLength(3);
  });

  it('429, 503, a network error and the 10 s timeout are "busy" while online, and nothing is cached', async () => {
    const { m, cache } = memCache();
    const make = (f: typeof globalThis.fetch) => createGeocoder({ fetch: f, cache, online: () => true, sleep: async () => {}, timeoutMs: 20 });
    expect((await make((async () => new Response('', { status: 429 })) as unknown as typeof fetch).lookup(roundCell(1, 1))).status).toBe('busy');
    expect((await make((async () => new Response('', { status: 503 })) as unknown as typeof fetch).lookup(roundCell(1, 1))).status).toBe('busy');
    expect(
      (
        await make((async () => {
          throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch).lookup(roundCell(1, 1))
      ).status,
    ).toBe('busy');
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    expect((await make(hang).lookup(roundCell(1, 1))).status).toBe('busy');
    expect(m.size).toBe(0);
  });

  it('offline: nothing is sent and the answer says offline; a network error after going offline is offline too', async () => {
    let called = 0;
    const fetch = (async () => {
      called++;
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const g = createGeocoder({ fetch, cache: memCache().cache, online: () => false, sleep: async () => {} });
    expect((await g.lookup(roundCell(1, 1))).status).toBe('offline');
    expect(called).toBe(0);
    let online = true;
    const g2 = createGeocoder({
      fetch: (async () => {
        online = false;
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof globalThis.fetch,
      cache: memCache().cache,
      online: () => online,
      sleep: async () => {},
    });
    expect((await g2.lookup(roundCell(1, 1))).status).toBe('offline');
  });

  it('sends nothing once the caller no longer wants it (Places closed)', async () => {
    let called = 0;
    const fetch = (async () => {
      called++;
      return json(ROAD);
    }) as unknown as typeof globalThis.fetch;
    const g = createGeocoder({ fetch, cache: memCache().cache, online: () => true, sleep: async () => {} });
    expect((await g.lookup(roundCell(1, 1), () => false)).status).toBe('cancelled');
    expect(called).toBe(0);
  });
});
