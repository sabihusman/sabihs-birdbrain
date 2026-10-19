/**
 * Full Wikipedia article text for the AI context, reduced to the sections a
 * bird question can draw on, capped, cached for seven days, and cited by
 * section link in answers.
 *
 * Endpoint: the MediaWiki Action API with the TextExtracts module,
 *   api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=…
 * With no exchars / exsentences / exintro the module returns the whole page
 * as plain text with "== Heading ==" section markers (exsectionformat=wiki);
 * exlimit only matters for several pages at once. Verified against the
 * Extension:TextExtracts documentation on mediawiki.org, 2026-10-19.
 */
import type { DatabaseSync } from 'node:sqlite';

const USER_AGENT = 'SabihsBirdbrainAPI/1.0 (https://github.com/sabihusman/sabihs-birdbrain)';
const API = 'https://en.wikipedia.org/w/api.php';
export const ARTICLE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Per section and in total: Wikipedia text is untrusted model input; keep it bounded. */
export const MAX_SECTION_CHARS = 2500;
export const MAX_CONTEXT_CHARS = 12_000;

export interface ArticleSection {
  /** Section heading as shown on Wikipedia ("Lead" for the text before the first heading). */
  heading: string;
  /** Link to the section: page URL plus "#anchor" (none for the lead). */
  url: string;
  text: string;
}

export interface WikiArticle {
  title: string;
  url: string;
  sections: ArticleSection[];
  fetchedAt: number;
}

export type ArticleFetcher = (scientific: string, common: string, now?: number) => Promise<WikiArticle | null>;

/** Headings worth keeping, matched case-insensitively against the start of a heading. */
export const RELEVANT_HEADINGS: ReadonlyArray<RegExp> = [
  /^lead$/i,
  /^description/i,
  /^identification/i,
  /^(vocali[sz]ation|voice|song|call)/i,
  /^(distribution|range|habitat|distribution and habitat)/i,
  /^(behaviou?r|ecology|breeding|nesting)/i,
  /^(diet|feeding|food)/i,
  /^(status|conservation|threats|population)/i,
  /^taxonomy/i,
];

/** Sections Wikipedia appends that never help a bird question. */
const SKIP_HEADINGS = /^(references|external links|see also|further reading|notes|footnotes|bibliography|gallery|cited texts|sources)$/i;

/** MediaWiki section anchor: spaces become underscores; the browser percent-encodes the rest. */
export function sectionAnchor(heading: string): string {
  return heading.trim().replace(/\s+/g, '_');
}

/** Split a TextExtracts plain-text extract (exsectionformat=wiki) into top-level sections. */
export function parseSections(extract: string, pageUrl: string): ArticleSection[] {
  const out: ArticleSection[] = [];
  let heading = 'Lead';
  let level = 0;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) out.push({ heading, url: heading === 'Lead' ? pageUrl : `${pageUrl}#${sectionAnchor(heading)}`, text });
    buf = [];
  };
  for (const line of extract.split('\n')) {
    const m = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (m) {
      const lvl = m[1].length;
      if (lvl <= 2 || level === 0) {
        flush();
        heading = m[2].trim();
        level = lvl;
      } else {
        // Sub-heading: keep it inside its parent section as a label line.
        buf.push(`${m[2].trim()}:`);
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Keep the relevant sections in article order, each capped, within the total budget. */
export function selectSections(sections: ArticleSection[], maxSection = MAX_SECTION_CHARS, maxTotal = MAX_CONTEXT_CHARS): ArticleSection[] {
  const kept: ArticleSection[] = [];
  let total = 0;
  for (const s of sections) {
    if (SKIP_HEADINGS.test(s.heading)) continue;
    if (!RELEVANT_HEADINGS.some((re) => re.test(s.heading))) continue;
    const text = s.text.length > maxSection ? `${s.text.slice(0, maxSection).replace(/\s+\S*$/, '')} […]` : s.text;
    if (total + text.length > maxTotal) {
      const room = maxTotal - total;
      if (room < 200) break;
      kept.push({ ...s, text: `${text.slice(0, room).replace(/\s+\S*$/, '')} […]` });
      break;
    }
    kept.push({ ...s, text });
    total += text.length;
  }
  return kept;
}

interface ExtractResponse {
  query?: { pages?: Array<{ title?: string; extract?: string; missing?: boolean; pageid?: number }> };
}

async function fetchExtract(title: string, signal: AbortSignal): Promise<{ title: string; extract: string } | null> {
  const params = new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', titles: title, format: 'json', formatversion: '2' });
  const res = await fetch(`${API}?${params.toString()}`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT }, signal });
  if (!res.ok) throw new Error(`Wikipedia responded ${res.status}`);
  const data = (await res.json()) as ExtractResponse;
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract || !page.title) return null;
  return { title: page.title, extract: page.extract };
}

export function pageUrlFor(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
}

/** Build the article context from a raw extract (pure; the fetcher and tests share it). */
export function articleFromExtract(title: string, extract: string, now = Date.now()): WikiArticle | null {
  const url = pageUrlFor(title);
  // eslint-disable-next-line no-control-regex
  const clean = extract.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const sections = selectSections(parseSections(clean, url));
  if (sections.length === 0) return null;
  return { title, url, sections, fetchedAt: now };
}

/** Scientific name first, then the common name; disambiguation pages have no usable sections. */
export const fetchWikipediaArticle: ArticleFetcher = async (scientific, common, now = Date.now()) => {
  const signal = AbortSignal.timeout(10_000);
  for (const name of [scientific, common]) {
    const page = await fetchExtract(name, signal);
    if (!page) continue;
    if (/may refer to:/i.test(page.extract.slice(0, 400))) continue;
    const article = articleFromExtract(page.title, page.extract, now);
    if (article) return article;
  }
  return null;
};

/** SQLite cache in front of an ArticleFetcher: one row per species, valid for ARTICLE_CACHE_TTL_MS. */
export function createArticleCache(db: DatabaseSync, ttlMs = ARTICLE_CACHE_TTL_MS) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_article_cache (
      key TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const get = db.prepare('SELECT fetched_at, payload FROM wiki_article_cache WHERE key = ?');
  const put = db.prepare('INSERT INTO wiki_article_cache (key, fetched_at, payload) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload');
  const del = db.prepare('DELETE FROM wiki_article_cache WHERE key = ?');
  return {
    wrap(fetcher: ArticleFetcher): ArticleFetcher {
      return async (scientific, common, now = Date.now()) => {
        const row = get.get(scientific) as { fetched_at: number; payload: string } | undefined;
        if (row && now - Number(row.fetched_at) < ttlMs) {
          try {
            return JSON.parse(row.payload) as WikiArticle;
          } catch {
            del.run(scientific);
          }
        }
        const article = await fetcher(scientific, common, now);
        if (article) put.run(scientific, now, JSON.stringify(article));
        return article;
      };
    },
  };
}
