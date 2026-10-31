import { describe, expect, it } from 'vitest';
import { createPlaceSearch, parsePlaces, placeSearchUrl, PLACE_SEARCH_LIMIT } from '../src/geo/place-search';
import { MIN_INTERVAL_MS } from '../src/geo/geocode';
import { placeName } from '../src/ui/components/location-recovery';

const ITHACA = { name: 'Ithaca', lat: '42.4396', lon: '-76.4970', address: { city: 'Ithaca', state: 'New York', country: 'United States' } };

describe('Pick a place (DECISIONS.md #105)', () => {
  it('asks Nominatim for a handful of matches by name, nothing else', () => {
    expect(placeSearchUrl('  Ithaca NY ', 'https://geo.example')).toBe(`https://geo.example/search?format=jsonv2&addressdetails=1&limit=${PLACE_SEARCH_LIMIT}&q=Ithaca%20NY`);
  });

  it('reads names, a second line and positions, and drops anything without them', () => {
    expect(parsePlaces([ITHACA, { name: 'Nowhere' }, { lat: '1', lon: '2' }, { name: 'Far', lat: '95', lon: '0' }])).toEqual([{ name: 'Ithaca', line2: 'New York, United States', lat: 42.4396, lon: -76.497 }]);
    expect(parsePlaces({ error: 'x' })).toEqual([]);
    expect(placeName({ name: 'Ithaca', line2: 'New York, United States' })).toBe('Ithaca, New York');
    expect(placeName({ name: 'Monaco', line2: '' })).toBe('Monaco');
  });

  it('searches only on a real query, keeps 1.1 s between requests, and caches answers', async () => {
    const store = new Map<string, { key: string; fetchedAt: number; data: unknown }>();
    const sent: string[] = [];
    const waits: number[] = [];
    let t = 1_000_000;
    const search = createPlaceSearch({
      baseUrl: 'https://geo.example',
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
      online: () => true,
      fetch: (async (url: string) => {
        sent.push(String(url));
        return new Response(JSON.stringify([ITHACA]));
      }) as unknown as typeof fetch,
      cache: { get: async (k: string) => store.get(k) as never, put: async (e: { key: string; fetchedAt: number; data: unknown }) => void store.set(e.key, e) } as never,
    });
    expect(await search(' I ')).toEqual({ status: 'too-short' });
    expect((await search('Ithaca')).status).toBe('ok');
    expect((await search('Ithaca, NY')).status).toBe('ok');
    expect(waits).toEqual([MIN_INTERVAL_MS]);
    expect(await search('ithaca')).toEqual({ status: 'ok', places: [{ name: 'Ithaca', line2: 'New York, United States', lat: 42.4396, lon: -76.497 }] });
    expect(sent).toHaveLength(2); // the third was answered from the cache
  });

  it('says busy or offline instead of failing', async () => {
    const busy = createPlaceSearch({ online: () => true, fetch: (async () => new Response('', { status: 429 })) as unknown as typeof fetch, cache: { get: async () => undefined, put: async () => undefined } as never });
    expect(await busy('Ithaca')).toEqual({ status: 'busy' });
    const off = createPlaceSearch({ online: () => false, cache: { get: async () => undefined, put: async () => undefined } as never });
    expect(await off('Ithaca')).toEqual({ status: 'offline' });
  });
});
