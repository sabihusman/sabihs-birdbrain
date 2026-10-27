import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../src/species/html-text';
import { getSpeciesSummary } from '../src/species/wiki';
import { putWikiCache } from '../src/storage/db';

const sp = (scientific: string, common: string) => ({ scientific, common, index: 0, isBird: true }) as never;

describe('HTML snippets from Wikipedia and Commons', () => {
  it('decodes the references that show up in titles and credits', () => {
    expect(decodeEntities('Swainson&#039;s thrush')).toBe("Swainson's thrush");
    expect(decodeEntities('Smith &amp; Jones &quot;Birds&quot; &#x27;99 &rsquo; &nbsp;')).toBe('Smith & Jones "Birds" \'99 ’  ');
    expect(decodeEntities('&bogus; &#0; &#xFFFFFFF;')).toBe('&bogus; &#0; &#xFFFFFFF;');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;'); // one level only
  });

  it('removes tags, then decodes, and turns empty into null', () => {
    expect(htmlToText('<span class="mw-page-title-main">Swainson&#039;s thrush</span>')).toBe("Swainson's thrush");
    expect(htmlToText('<a href="//commons.wikimedia.org/wiki/User:X" title="User:X">O&#039;Brien</a>\n &amp; co')).toBe("O'Brien & co");
    expect(htmlToText('<span></span>')).toBeNull();
    expect(htmlToText(undefined)).toBeNull();
  });
});

describe('species summary text', () => {
  it('shows the page title and the photo credit with real apostrophes', async () => {
    const fetchFn = (async (input: string) => {
      const url = String(input);
      if (url.includes('/page/summary/')) {
        return new Response(
          JSON.stringify({
            type: 'standard',
            title: "Swainson's thrush",
            displaytitle: '<span class="mw-page-title-main">Swainson&#039;s thrush</span>',
            extract: "Swainson's thrush is a North American bird.",
            originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Catharus.jpg', width: 1, height: 1 },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          query: { pages: [{ imageinfo: [{ extmetadata: { Artist: { value: '<a href="x">Mary O&#039;Neil</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://example.org/?a=1&amp;b=2' } } }] }] },
        }),
      );
    }) as unknown as typeof fetch;
    const r = await getSpeciesSummary(sp('Catharus ustulatus', "Swainson's Thrush"), { force: true, fetchFn });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.displayTitle).toBe("Swainson's thrush");
    expect(r.image?.artist).toBe("Mary O'Neil");
    expect(r.image?.licenseUrl).toBe('https://example.org/?a=1&b=2');
  });

  it('cleans summaries cached by the earlier version', async () => {
    await putWikiCache({
      key: 'wiki:en:Catharus guttatus',
      fetchedAt: Date.now(),
      data: {
        status: 'ok',
        title: 'Hermit thrush',
        displayTitle: 'Hermit&#039;s thrush',
        description: null,
        extract: '',
        thumbnail: null,
        originalImage: null,
        pageUrl: 'https://en.wikipedia.org/wiki/Hermit_thrush',
        lookedUpBy: 'scientific',
        image: { fileName: 'a.jpg', filePageUrl: 'x', artist: 'Jo O&#039;Hara', license: null, licenseUrl: null, credit: null },
        fetchedAt: Date.now(),
      },
    });
    const r = await getSpeciesSummary(sp('Catharus guttatus', 'Hermit Thrush'));
    expect(r.status === 'ok' && r.displayTitle).toBe("Hermit's thrush");
    expect(r.status === 'ok' && r.image?.artist).toBe("Jo O'Hara");
  });
});
