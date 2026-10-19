import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion, askSchema, buildSource, extractCitations, fetchExtraSources, SYSTEM_INSTRUCTION, type AskDeps } from '../src/ask.js';
import { createUsageStore, openDatabase } from '../src/db.js';
import { createEbirdApi, createEbirdSource, EBIRD_OBS_CACHE_TTL_MS, EBIRD_TAXONOMY_CACHE_TTL_MS, ebirdText, MAX_OBSERVATIONS, normalizeObservations, stripCoordinates, taxonomyMap, type EbirdApi, type EbirdObservation } from '../src/ebird.js';
import { createNatureServeCache, describeRank, fetchNatureServeStatus, NATURESERVE_CACHE_TTL_MS, natureServeText, recordUrl, statusFromSearch } from '../src/natureserve.js';
import { REGION_CODES } from '../src/regions.js';
import { parseLabels } from '../src/labels.js';
import { LABELS } from './helpers.js';

const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const nsFixture = read('natureserve-robin.json');
const taxonomyFixture = read('ebird-taxonomy.json') as { rows: unknown[] };
const obsFixture = read('ebird-obs-region.json') as { rows: unknown[] };
const ROBIN = 'Turdus migratorius';
const T0 = Date.UTC(2026, 9, 19, 12);

afterEach(() => vi.unstubAllGlobals());

describe('request shape', () => {
  const schema = askSchema(500);
  it('accepts region codes from the fixed list, "none", and a point rounded to one decimal', () => {
    for (const region of [...REGION_CODES, 'none']) expect(schema.safeParse({ species: ROBIN, question: 'Is it rare?', region }).success, region).toBe(true);
    expect(schema.safeParse({ species: ROBIN, question: 'Seen near me?', region: 'US-IA', near: { lat: 41.7, lon: -91.5 } }).success).toBe(true);
    expect(schema.safeParse({ species: ROBIN, question: 'Seen near me?', near: { lat: 0, lon: 0 } }).success).toBe(true);
    expect(schema.safeParse({ species: ROBIN, question: 'Seen near me?', near: { lat: -90, lon: 180 } }).success).toBe(true);
  });
  it('rejects other regions, precise coordinates, out-of-range values and extra fields', () => {
    const bad: Array<[string, unknown]> = [
      ['other state', { species: ROBIN, question: 'q?', region: 'US-NY' }],
      ['lowercase', { species: ROBIN, question: 'q?', region: 'us-ia' }],
      ['two decimals', { species: ROBIN, question: 'q?', near: { lat: 41.66, lon: -91.5 } }],
      ['many decimals', { species: ROBIN, question: 'q?', near: { lat: 41.6611, lon: -91.5302 } }],
      ['lat out of range', { species: ROBIN, question: 'q?', near: { lat: 90.1, lon: 0 } }],
      ['lon out of range', { species: ROBIN, question: 'q?', near: { lat: 0, lon: -180.1 } }],
      ['string coords', { species: ROBIN, question: 'q?', near: { lat: '41.7', lon: '-91.5' } }],
      ['extra field in near', { species: ROBIN, question: 'q?', near: { lat: 41.7, lon: -91.5, accuracy: 5 } }],
      ['missing lon', { species: ROBIN, question: 'q?', near: { lat: 41.7 } }],
      ['NaN', { species: ROBIN, question: 'q?', near: { lat: Number.NaN, lon: 0 } }],
    ];
    for (const [name, body] of bad) expect(schema.safeParse(body).success, name).toBe(false);
  });
});

describe('NatureServe Explorer', () => {
  it('reads the global rank and every S-rank from the recorded speciesSearch response', () => {
    const s = statusFromSearch(ROBIN, nsFixture, T0)!;
    expect(s.common).toBe('American Robin');
    expect(s.globalRank).toBe('G5');
    expect(s.url).toBe('https://explorer.natureserve.org/Taxon/ELEMENT_GLOBAL.2.102179/Turdus_migratorius');
    expect(s.subnational['US-IA']).toBe('S5B,S5N');
    expect(s.subnational['CA-ON']).toBe('S5');
    expect(s.subnational['CA-AB']).toBe('S5B,SUN');
    expect(statusFromSearch('Turdus merula', nsFixture)).toBeNull(); // the hit must be the species asked for
    expect(statusFromSearch(ROBIN, {})).toBeNull();
  });

  it('writes the S-rank for the given region, says so for "none", and says so when the region has no rank', () => {
    const s = statusFromSearch(ROBIN, nsFixture)!;
    expect(natureServeText(s, 'US-IA')).toBe('NatureServe global conservation status rank for American Robin: G5 (secure).\nNatureServe state/province rank in Iowa (US-IA): S5B (secure, breeding population), S5N (secure, non-breeding population).');
    expect(natureServeText(s, 'none')).toContain('no state/province (S) rank is included');
    expect(natureServeText(s, 'none')).not.toMatch(/Iowa|Illinois|Washington|Alberta|Ontario/);
    expect(natureServeText({ ...s, subnational: {} }, 'US-WA')).toContain('lists no state/province rank for this species in Washington (US-WA)');
    expect(describeRank('G3G4')).toBe('G3G4'); // range ranks are left as they are
    expect(describeRank('SNR')).toBe('SNR (not ranked)');
    expect(describeRank('S2?')).toBe('S2? (imperiled)');
    expect(recordUrl('/Taxon/ELEMENT_GLOBAL.2.1/X_y')).toBe('https://explorer.natureserve.org/Taxon/ELEMENT_GLOBAL.2.1/X_y');
    expect(recordUrl('https://evil.example/x')).toBe('https://explorer.natureserve.org');
    expect(recordUrl('/Taxon/a"><script>')).toBe('https://explorer.natureserve.org');
  });

  it('fetchNatureServeStatus posts the documented speciesSearch body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(nsFixture), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const s = await fetchNatureServeStatus(ROBIN, T0);
    expect(s?.globalRank).toBe('G5');
    expect(calls[0].url).toBe('https://explorer.natureserve.org/api/data/speciesSearch');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ criteriaType: 'species', textCriteria: [{ paramType: 'textSearch', searchToken: ROBIN, matchAgainst: 'scientificName', operator: 'equals' }], pagingOptions: { page: 0, recordsPerPage: 5 } });
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 503 }));
    await expect(fetchNatureServeStatus(ROBIN)).rejects.toThrow(/503/);
  });

  it('caches a species for 30 days (misses too) and refetches after that', async () => {
    const db = openDatabase(':memory:');
    let fetches = 0;
    const fetcher = createNatureServeCache(db).wrap(async (sci, now) => {
      fetches++;
      return sci === ROBIN ? statusFromSearch(ROBIN, nsFixture, now) : null;
    });
    expect((await fetcher(ROBIN, T0))?.fetchedAt).toBe(T0);
    expect((await fetcher(ROBIN, T0 + NATURESERVE_CACHE_TTL_MS - 1000))?.fetchedAt).toBe(T0);
    expect(fetches).toBe(1);
    expect((await fetcher(ROBIN, T0 + NATURESERVE_CACHE_TTL_MS + 1))?.fetchedAt).toBe(T0 + NATURESERVE_CACHE_TTL_MS + 1);
    expect(fetches).toBe(2);
    expect(await fetcher('Nope nope', T0)).toBeNull();
    expect(await fetcher('Nope nope', T0 + 1000)).toBeNull();
    expect(fetches).toBe(3);
  });
});

describe('eBird', () => {
  it('maps scientific names to species codes from the taxonomy rows', () => {
    const map = taxonomyMap(taxonomyFixture.rows);
    expect(map['turdus migratorius']).toBe('amerob');
    expect(map['turdus merula']).toBe('eurbla');
    expect(taxonomyMap([{ sciName: 'X y', speciesCode: 'xxx', category: 'issf' }, { sciName: 'Bad', speciesCode: '<b>' }, 'junk'])).toEqual({});
  });

  it('keeps only locality, date and count; private locations and embedded coordinates never reach the prompt', () => {
    const obs = normalizeObservations(obsFixture.rows);
    expect(obs).toEqual<EbirdObservation[]>([
      { locality: 'Hanshaw Rd. fields', date: '2026-10-17', count: 30 },
      { locality: 'a private location', date: '2026-10-16', count: 13 },
      { locality: 'Hickory Grove Park', date: '2026-10-12', count: null },
    ]);
    expect(JSON.stringify(obs)).not.toMatch(/42\.4|-76\.4|75\.00|Locust|lat|lng|locId/);
    expect(stripCoordinates('169 Locust Ln, Richfield US-NY (42.8366,-75.0028)')).toBe('169 Locust Ln, Richfield US-NY');
    expect(stripCoordinates('Trail 41.95, -92.98 end')).toBe('Trail end');
    const many = normalizeObservations(Array.from({ length: 40 }, (_, i) => ({ locName: `L${i}`, obsDt: `2026-10-${String(1 + (i % 28)).padStart(2, '0')} 08:00`, howMany: i })));
    expect(many.length).toBe(MAX_OBSERVATIONS);
    expect(many[0].date >= many[many.length - 1].date).toBe(true);
    expect(normalizeObservations([{ locName: 'X', obsDt: 'yesterday', howMany: -1 }, { locName: '', obsDt: '2026-10-01' }])).toEqual([{ locality: 'X', date: 'unknown date', count: null }, { locality: 'an unnamed location', date: '2026-10-01', count: null }]);
    expect(normalizeObservations('nope')).toEqual([]);
  });

  it('writes the sightings section with date, location and count only, and says when there are none', () => {
    const text = ebirdText(normalizeObservations(obsFixture.rows), { kind: 'region', region: 'US-IA' });
    expect(text).toContain('in Iowa (US-IA) in the last 30 days');
    expect(text).toContain('2026-10-17: Hanshaw Rd. fields, 30 birds');
    expect(text).toContain('2026-10-12: Hickory Grove Park (count not given)');
    expect(ebirdText([], { kind: 'near' })).toBe("eBird lists no reports of this species within 50 km of the asker's approximate position (rounded to about 10 km) in the last 30 days.");
    expect(ebirdText([{ locality: 'Park', date: '2026-10-01', count: 1 }], { kind: 'near' })).toContain('2026-10-01: Park, 1 bird');
  });

  it('createEbirdApi calls the documented endpoints with the key in the X-eBirdApiToken header', async () => {
    const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ url: u, headers: init.headers as Record<string, string> });
      const body = u.pathname.includes('/ref/taxonomy/') ? taxonomyFixture.rows : obsFixture.rows;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const api = createEbirdApi('secret-key');
    expect((await api.taxonomy())['turdus migratorius']).toBe('amerob');
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://api.ebird.org/v2/ref/taxonomy/ebird');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ fmt: 'json', cat: 'species' });
    expect(calls[0].headers['X-eBirdApiToken']).toBe('secret-key');
    expect(calls[0].url.searchParams.has('key')).toBe(false); // never in the URL
    expect((await api.recentInRegion('amerob', 'US-IA')).length).toBe(3);
    expect(calls[1].url.pathname).toBe('/v2/data/obs/US-IA/recent/amerob');
    expect(Object.fromEntries(calls[1].url.searchParams)).toEqual({ back: '30' });
    await api.recentNearby('amerob', 41.7, -91.5);
    expect(calls[2].url.pathname).toBe('/v2/data/obs/geo/recent/amerob');
    expect(Object.fromEntries(calls[2].url.searchParams)).toEqual({ lat: '41.70', lng: '-91.50', back: '30', dist: '50' });
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }));
    await expect(api.recentInRegion('amerob', 'US-IA')).rejects.toThrow(/403/);
  });

  it('caches observations for one hour per species+region / species+point and the taxonomy for 30 days', async () => {
    const db = openDatabase(':memory:');
    const counts = { taxonomy: 0, region: 0, near: 0 };
    const api: EbirdApi = {
      taxonomy: async () => (counts.taxonomy++, taxonomyMap(taxonomyFixture.rows)),
      recentInRegion: async () => (counts.region++, normalizeObservations(obsFixture.rows)),
      recentNearby: async () => (counts.near++, []),
    };
    const src = createEbirdSource(db, api);
    expect(await src.speciesCode(ROBIN, T0)).toBe('amerob');
    expect(await src.speciesCode('Turdus merula', T0 + 1000)).toBe('eurbla');
    expect(await src.speciesCode('Nope nope', T0 + 2000)).toBeNull();
    expect(counts.taxonomy).toBe(1);
    await src.speciesCode(ROBIN, T0 + EBIRD_TAXONOMY_CACHE_TTL_MS + 1);
    expect(counts.taxonomy).toBe(2);

    expect((await src.recentInRegion('amerob', 'US-IA', T0)).length).toBe(3);
    await src.recentInRegion('amerob', 'US-IA', T0 + EBIRD_OBS_CACHE_TTL_MS - 1);
    expect(counts.region).toBe(1);
    await src.recentInRegion('amerob', 'US-IL', T0); // another region: another row
    expect(counts.region).toBe(2);
    await src.recentInRegion('amerob', 'US-IA', T0 + EBIRD_OBS_CACHE_TTL_MS + 1);
    expect(counts.region).toBe(3);

    await src.recentNearby('amerob', 41.7, -91.5, T0);
    await src.recentNearby('amerob', 41.7, -91.5, T0 + 60_000);
    expect(counts.near).toBe(1);
    await src.recentNearby('amerob', 41.8, -91.5, T0);
    expect(counts.near).toBe(2);
  });
});

/** Fake sources for the pipeline tests: counters say which calls happened. */
function fakeSources(opts: { natureserve?: 'ok' | 'throw' | 'none'; ebird?: 'ok' | 'throw' | 'off' | 'unknown' } = {}) {
  const calls: string[] = [];
  const natureserve: AskDeps['natureserve'] =
    opts.natureserve === 'none'
      ? undefined
      : async (sci, now) => {
          calls.push('natureserve');
          if (opts.natureserve === 'throw') throw new Error('timeout');
          return statusFromSearch(ROBIN, nsFixture, now);
        };
  const ebird: AskDeps['ebird'] =
    opts.ebird === 'off'
      ? null
      : {
          speciesCode: async (sci) => (calls.push('ebird:code'), opts.ebird === 'unknown' ? null : sci === ROBIN ? 'amerob' : 'eurbla'),
          recentInRegion: async (_c, region) => {
            calls.push(`ebird:region:${region}`);
            if (opts.ebird === 'throw') throw new Error('503');
            return normalizeObservations(obsFixture.rows);
          },
          recentNearby: async (_c, lat, lon) => (calls.push(`ebird:near:${lat},${lon}`), [{ locality: 'Riverside Park', date: '2026-10-15', count: 4 }]),
        };
  return { calls, natureserve, ebird };
}

function pipelineDeps(sources: ReturnType<typeof fakeSources>, prompts: string[], reply = 'It is secure [NatureServe Explorer – Conservation status]. Seen at Hanshaw Rd. fields [eBird – Recent sightings]. It eats seeds [Wikipedia – Summary].'): AskDeps {
  return {
    labels: LABELS,
    wiki: async (sci) => ({ title: sci, extract: `${sci} eats seeds.`, url: `https://en.wikipedia.org/wiki/${sci.replace(' ', '_')}` }),
    model: async (i) => (prompts.push(i.prompt), reply),
    usage: createUsageStore(openDatabase(':memory:')),
    caps: { perUserDaily: 50, globalDaily: 50 },
    maxQuestionChars: 500,
    natureserve: sources.natureserve,
    ebird: sources.ebird,
  };
}

const LABELS_WITH_ROBIN = parseLabels([...LABELS.byScientific].map(([sci, common]) => `${sci}_${common}`).concat([`${ROBIN}_American Robin`]));

describe('the ask pipeline with three sources', () => {
  const user = { id: 'u', status: 'approved' };

  it('fences every source with a labelled section, cites all three, and lists the sources used', async () => {
    const sources = fakeSources();
    const prompts: string[] = [];
    const deps = { ...pipelineDeps(sources, prompts), labels: LABELS_WITH_ROBIN };
    const out = await answerQuestion(deps, user, { species: ROBIN, question: 'Is it rare here?', region: 'US-IA' });
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    const p = prompts[0];
    expect(p.match(/<source>/g)?.length).toBe(1);
    expect(p.match(/<\/source>/g)?.length).toBe(1);
    expect(p).toContain('[Section: Wikipedia – Summary]');
    expect(p).toContain('[Section: NatureServe Explorer – Conservation status]\nNatureServe global conservation status rank for American Robin: G5 (secure).\nNatureServe state/province rank in Iowa (US-IA): S5B');
    expect(p).toContain('[Section: eBird – Recent sightings]\nReports of this species to eBird in Iowa (US-IA)');
    expect(p).not.toContain('Recent sightings nearby'); // no `near` → no nearby query
    expect(sources.calls).toEqual(['natureserve', 'ebird:code', 'ebird:region:US-IA']);
    expect(out.body.sources).toEqual([
      { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Turdus_migratorius' },
      { name: 'NatureServe Explorer', url: 'https://explorer.natureserve.org/Taxon/ELEMENT_GLOBAL.2.102179/Turdus_migratorius' },
      { name: 'eBird', url: 'https://ebird.org/species/amerob' },
    ]);
    expect(out.body.citations.map((c) => [c.source, c.section])).toEqual([
      ['NatureServe Explorer', 'NatureServe Explorer – Conservation status'],
      ['eBird', 'eBird – Recent sightings'],
      ['Wikipedia', 'Wikipedia – Summary'],
    ]);
    expect(out.body.citations[2].url).toBe('https://en.wikipedia.org/wiki/Turdus_migratorius');
    expect(out.body.region).toBe('US-IA');
    expect(out.body.source).toEqual({ title: ROBIN, url: 'https://en.wikipedia.org/wiki/Turdus_migratorius' }); // kept for older clients
  });

  it('region "none": global rank only, no S-rank, no eBird region query; the nearby query runs only with `near`', async () => {
    const sources = fakeSources();
    const prompts: string[] = [];
    const deps = { ...pipelineDeps(sources, prompts), labels: LABELS_WITH_ROBIN };
    const out = await answerQuestion(deps, user, { species: ROBIN, question: 'Is it rare?', region: 'none' });
    expect(out.status).toBe(200);
    expect(prompts[0]).toContain('G5 (secure)');
    expect(prompts[0]).toContain('no state/province (S) rank is included');
    expect(prompts[0]).not.toContain('eBird');
    expect(sources.calls).toEqual(['natureserve']);
    if (out.status === 200) expect(out.body.sources.map((s) => s.name)).toEqual(['Wikipedia', 'NatureServe Explorer']);

    sources.calls.length = 0;
    const near = await answerQuestion(deps, user, { species: ROBIN, question: 'Any near me?', region: 'none', near: { lat: 41.7, lon: -91.5 } });
    expect(near.status).toBe(200);
    expect(sources.calls).toEqual(['natureserve', 'ebird:code', 'ebird:near:41.7,-91.5']);
    expect(prompts[1]).toContain('[Section: eBird – Recent sightings nearby]');
    expect(prompts[1]).toContain("within 50 km of the asker's approximate position");
    expect(prompts[1]).not.toContain('41.7'); // the point itself stays out of the prompt
    expect(prompts[1]).not.toContain('[Section: eBird – Recent sightings]\n');

    sources.calls.length = 0;
    await answerQuestion(deps, user, { species: ROBIN, question: 'Any near me?', region: 'US-IL', near: { lat: 41.7, lon: -91.5 } });
    expect(sources.calls).toEqual(['natureserve', 'ebird:code', 'ebird:region:US-IL', 'ebird:near:41.7,-91.5']);
    expect(prompts[2]).toContain('[Section: eBird – Recent sightings]');
    expect(prompts[2]).toContain('[Section: eBird – Recent sightings nearby]');
  });

  it('without EBIRD_API_KEY (ebird null) and for a species eBird does not list, eBird is skipped cleanly', async () => {
    for (const mode of ['off', 'unknown'] as const) {
      const sources = fakeSources({ ebird: mode });
      const prompts: string[] = [];
      const out = await answerQuestion({ ...pipelineDeps(sources, prompts), labels: LABELS_WITH_ROBIN }, user, { species: ROBIN, question: 'Seen nearby?', region: 'US-IA', near: { lat: 41.7, lon: -91.5 } });
      expect(out.status, mode).toBe(200);
      expect(prompts[0]).not.toContain('eBird');
      if (out.status === 200) expect(out.body.sources.map((s) => s.name)).toEqual(['Wikipedia', 'NatureServe Explorer']);
      expect(sources.calls.filter((c) => c.startsWith('ebird:region') || c.startsWith('ebird:near'))).toEqual([]);
    }
  });

  it('a failing or absent source is left out and the answer still comes from the rest', async () => {
    const sources = fakeSources({ natureserve: 'throw', ebird: 'throw' });
    const prompts: string[] = [];
    const out = await answerQuestion({ ...pipelineDeps(sources, prompts), labels: LABELS_WITH_ROBIN }, user, { species: ROBIN, question: 'Is it rare?', region: 'US-IA' });
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.sources).toEqual([{ name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Turdus_migratorius' }]);
    expect(prompts[0]).not.toMatch(/NatureServe|eBird/);
    expect(out.body.citations.map((c) => c.section)).toEqual(['Wikipedia – Summary']); // citations of sections not in the prompt are dropped
    const none = await answerQuestion({ ...pipelineDeps(fakeSources({ natureserve: 'none', ebird: 'off' }), prompts), labels: LABELS_WITH_ROBIN }, user, { species: ROBIN, question: 'Is it rare?' });
    expect(none.status).toBe(200);
    if (none.status === 200) expect(none.body.sources.map((s) => s.name)).toEqual(['Wikipedia']);
  });

  it('older clients that send no region get the same answer shape, and the instruction carries the role and "sources differ" rules', async () => {
    const sources = fakeSources();
    const prompts: string[] = [];
    const out = await answerQuestion({ ...pipelineDeps(sources, prompts), labels: LABELS_WITH_ROBIN }, user, { species: ROBIN, question: 'Is it rare?' });
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.region).toBe('none');
    expect(Object.keys(out.body).sort()).toEqual(['answer', 'citations', 'context', 'region', 'source', 'sources']);
    for (const phrase of ['Wikipedia sections cover the biology', 'NatureServe Explorer sections cover its conservation status', 'eBird sections cover recent sightings', 'say "sources differ"', 'Never invent counts, dates, places or ranks', 'Label every fact with its source']) expect(SYSTEM_INSTRUCTION).toContain(phrase);
  });

  it('fetchExtraSources runs both lookups concurrently and never throws', async () => {
    const slow = { natureserve: async () => new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('timeout')), 5)), ebird: { speciesCode: async () => { throw new Error('boom'); }, recentInRegion: async () => [], recentNearby: async () => [] } };
    const r = await fetchExtraSources(slow, ROBIN, 'US-IA', { lat: 41.7, lon: -91.5 }, T0);
    expect(r).toEqual({ sections: [], sources: [] });
    expect(buildSource(r.sections)).toBe('');
    expect(extractCitations('[eBird – Recent sightings]', r.sections)).toEqual([]);
  });
});
