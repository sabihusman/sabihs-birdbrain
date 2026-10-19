import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Species } from '../src/model/labels';
import { extractRequestUrl, getSpeciesSections, MAX_SECTION_CHARS, parseSections, pickSections, sectionsFromExtract, truncateAtSentence, wikiSectionsKey } from '../src/species/wiki-sections';
import { clearAllData, getWikiCache } from '../src/storage/db';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/wiki-extract-redpoll.json', import.meta.url), 'utf8')) as { query: { pages: Array<{ title: string; extract: string }> } };
const extract = fixture.query.pages[0].extract;
const redpoll: Species = { index: 1, label: 'Acanthis cabaret_Lesser Redpoll', scientific: 'Acanthis cabaret', common: 'Lesser Redpoll', isBird: true };

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('parseSections', () => {
  it('splits a TextExtracts wiki-format extract at every heading level', () => {
    const sections = parseSections(extract);
    expect(sections.map((s) => `${s.level}:${s.heading}`)).toEqual([
      '0:Lead',
      '2:Taxonomy',
      '2:Description',
      '3:Vocalisations',
      '2:Distribution and habitat',
      '3:Breeding',
      '3:Diet',
      '2:Status',
      '2:References',
      '2:External links',
    ]);
    // An empty parent ("Behaviour and ecology") is dropped; the sub-section text is not folded into Description.
    expect(sections.find((s) => s.heading === 'Description')!.text).not.toContain('chett-chett');
    expect(sections.find((s) => s.heading === 'Vocalisations')!.text).toContain('chett-chett');
  });
  it('strips control characters and keeps paragraph breaks', () => {
    const [lead] = parseSections('One.\u0007\n\n\n\nTwo.');
    expect(lead.text).toBe('One.\n\nTwo.');
  });
});

describe('truncateAtSentence', () => {
  it('leaves short text alone', () => {
    expect(truncateAtSentence('A bird. Another bird.', 100)).toEqual({ text: 'A bird. Another bird.', truncated: false });
  });
  it('cuts at the last sentence end within the limit', () => {
    const text = 'First sentence is here. Second sentence follows it. Third one is cut.';
    const out = truncateAtSentence(text, 52);
    expect(out).toEqual({ text: 'First sentence is here. Second sentence follows it.', truncated: true });
  });
  it('falls back to a word boundary with an ellipsis when no sentence ends in the window', () => {
    const text = 'word '.repeat(40).trim();
    const out = truncateAtSentence(text, 32);
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith(' […]')).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(32 + 4);
  });
});

describe('pickSections', () => {
  it('picks Description, Song (a sub-heading), Habitat ("Distribution and habitat") and Diet, in that order, with section links', () => {
    const picked = pickSections(parseSections(extract), 'https://en.wikipedia.org/wiki/Lesser_redpoll');
    expect(picked.map((s) => [s.kind, s.heading])).toEqual([
      ['description', 'Description'],
      ['song', 'Vocalisations'],
      ['habitat', 'Distribution and habitat'],
      ['diet', 'Diet'],
    ]);
    expect(picked[1].url).toBe('https://en.wikipedia.org/wiki/Lesser_redpoll#Vocalisations');
    expect(picked[2].url).toBe('https://en.wikipedia.org/wiki/Lesser_redpoll#Distribution_and_habitat');
    // The long Description is cut at a sentence end at or under the cap; the short ones are intact.
    expect(picked[0].truncated).toBe(true);
    expect(picked[0].text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    expect(picked[0].text.endsWith('.')).toBe(true);
    expect(picked[3].truncated).toBe(false);
    expect(picked[3].text).toContain('nyjer seed');
  });
  it('skips kinds without a matching heading', () => {
    const picked = pickSections(parseSections('Lead.\n\n== Diet ==\nSeeds.'), 'https://x/y');
    expect(picked.map((s) => s.kind)).toEqual(['diet']);
  });
});

describe('getSpeciesSections', () => {
  afterEach(async () => {
    // The app's db module keeps one open connection; clear the stores rather than deleting the database.
    await clearAllData();
  });

  it('builds the TextExtracts request the server uses, plus origin=* for the browser', () => {
    const url = new URL(extractRequestUrl('Acanthis cabaret'));
    expect(url.origin + url.pathname).toBe('https://en.wikipedia.org/w/api.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: 'Acanthis cabaret', format: 'json', formatversion: '2', origin: '*' });
  });

  it('fetches by scientific name, caches in the wiki store and serves the cache next time', async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse(fixture);
    };
    const first = await getSpeciesSections(redpoll, { fetchFn });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('unreachable');
    expect(first.title).toBe('Lesser redpoll');
    expect(first.pageUrl).toBe('https://en.wikipedia.org/wiki/Lesser_redpoll');
    expect(first.sections.map((s) => s.kind)).toEqual(['description', 'song', 'habitat', 'diet']);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.get('titles')).toBe('Acanthis cabaret');
    const cached = await getWikiCache(wikiSectionsKey(redpoll));
    expect(cached?.data).toEqual(first);

    const second = await getSpeciesSections(redpoll, { fetchFn });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it('falls back to the common name when the scientific page is missing or a disambiguation', async () => {
    const titles: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const t = new URL(String(input)).searchParams.get('titles')!;
      titles.push(t);
      if (t === 'Acanthis cabaret') return jsonResponse({ query: { pages: [{ title: 'Acanthis cabaret', extract: 'Acanthis cabaret may refer to:\n\nA bird\nA band' }] } });
      return jsonResponse(fixture);
    };
    const res = await getSpeciesSections(redpoll, { fetchFn });
    expect(res.status).toBe('ok');
    expect(titles).toEqual(['Acanthis cabaret', 'Lesser Redpoll']);
  });

  it('reports not-found when neither page exists, and error on a non-200', async () => {
    const missing: typeof fetch = async () => jsonResponse({ query: { pages: [{ title: 'x', missing: true }] } });
    expect(await getSpeciesSections(redpoll, { fetchFn: missing })).toEqual({ status: 'not-found' });
    const limited: typeof fetch = async () => new Response('slow down', { status: 429 });
    expect(await getSpeciesSections(redpoll, { fetchFn: limited })).toEqual({ status: 'error', message: 'Wikipedia returned 429' });
  });

  it('is offline without a cache, and serves the cache when the network fails later', async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await getSpeciesSections(redpoll, { fetchFn: failing })).toEqual({ status: 'offline' });
    const ok = await getSpeciesSections(redpoll, { fetchFn: async () => jsonResponse(fixture) });
    expect(ok.status).toBe('ok');
    // force bypasses the cache but a network failure falls back to it.
    expect(await getSpeciesSections(redpoll, { fetchFn: failing, force: true })).toEqual(ok);
  });

  it('sectionsFromExtract is pure and stamps the time it is given', () => {
    const r = sectionsFromExtract('Lesser redpoll', extract, 1234);
    expect(r.fetchedAt).toBe(1234);
    expect(r.sections).toHaveLength(4);
  });
});
