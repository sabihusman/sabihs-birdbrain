/**
 * Short article sections for the "About this bird" box: Description, Song and
 * calls, Habitat and Diet from the full Wikipedia article, each cut to about
 * 600 characters at a sentence end, cached in IndexedDB for offline use.
 *
 * Same endpoint as the server's AI context (server/src/wiki-article.ts,
 * DECISIONS.md #37): the MediaWiki Action API, TextExtracts module,
 *   api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=…&format=json&formatversion=2&origin=*
 * With no exchars / exsentences / exintro it returns the whole page as plain
 * text with "== Heading ==" markers; `origin=*` is what the Action API needs
 * for an anonymous cross-origin browser request. Parameters checked against
 * the module help on mediawiki.org (action=help&modules=query+extracts) on
 * 2026-10-19.
 */
import type { Species } from '../model/labels';
import { getWikiCache, putWikiCache } from '../storage/db';
import { WIKI_USER_AGENT } from './wiki';

const ACTION_API = 'https://en.wikipedia.org/w/api.php';
/** Each section is cut to about this many characters, at a sentence end. */
export const MAX_SECTION_CHARS = 600;

export type SectionKind = 'description' | 'song' | 'habitat' | 'diet';

/** Card labels, in display order. */
export const SECTION_KINDS: ReadonlyArray<SectionKind> = ['description', 'song', 'habitat', 'diet'];
export const SECTION_LABELS: Record<SectionKind, string> = {
  description: 'Description',
  song: 'Song and calls',
  habitat: 'Habitat',
  diet: 'Diet',
};

/** Heading patterns per kind, matched case-insensitively against the start of a heading; the first match in article order wins. */
export const SECTION_PATTERNS: Record<SectionKind, ReadonlyArray<RegExp>> = {
  description: [/^description/i, /^identification/i, /^appearance/i],
  song: [/^vocali[sz]ation/i, /^voice/i, /^song/i, /^call/i, /^sounds?\b/i],
  habitat: [/^distribution and habitat/i, /^habitat/i, /^distribution/i, /^range/i],
  diet: [/^diet/i, /^feeding/i, /^food/i, /^foraging/i],
};

/** One heading of the article (any level) with the text directly under it. */
export interface ArticleSection {
  heading: string;
  level: number;
  text: string;
}

export interface WikiSection {
  kind: SectionKind;
  /** Heading as shown on Wikipedia. */
  heading: string;
  /** Plain text, paragraphs separated by a blank line, cut at a sentence end. */
  text: string;
  truncated: boolean;
  /** Link to the section on Wikipedia. */
  url: string;
}

export interface WikiSections {
  status: 'ok';
  title: string;
  pageUrl: string;
  sections: WikiSection[];
  fetchedAt: number;
}

export type WikiSectionsResult = WikiSections | { status: 'not-found' } | { status: 'offline' } | { status: 'error'; message: string };

export function pageUrlFor(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`;
}

/** MediaWiki section anchor: spaces become underscores; the browser percent-encodes the rest. */
export function sectionAnchor(heading: string): string {
  return heading.trim().replace(/\s+/g, '_');
}

/**
 * Split a TextExtracts plain-text extract (exsectionformat=wiki) into sections,
 * one per heading of any level ("Lead" for the text before the first). Unlike
 * the server, sub-headings are not folded into their parent: the card wants
 * "Vocalisations" on its own even when it sits under "Description".
 */
export function parseSections(extract: string): ArticleSection[] {
  const out: ArticleSection[] = [];
  let heading = 'Lead';
  let level = 0;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text) out.push({ heading, level, text });
    buf = [];
  };
  // eslint-disable-next-line no-control-regex
  const clean = extract.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  for (const line of clean.split('\n')) {
    const m = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
      level = m[1].length;
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** Cut text to about `max` characters at the last sentence end, or at a word boundary with an ellipsis when no sentence end is near. */
export function truncateAtSentence(text: string, max = MAX_SECTION_CHARS): { text: string; truncated: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, truncated: false };
  const head = t.slice(0, max + 1);
  let cut = -1;
  const re = /[.!?]["')\]]?(?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) {
    const end = m.index + m[0].length;
    if (end <= max) cut = end;
  }
  if (cut >= Math.floor(max * 0.4)) return { text: t.slice(0, cut).trim(), truncated: true };
  const words = t.slice(0, max).replace(/\s+\S*$/, '').trim();
  return { text: `${words} […]`, truncated: true };
}

/** Pick the first section of each kind, in display order, cut to size. */
export function pickSections(sections: ArticleSection[], pageUrl: string, max = MAX_SECTION_CHARS): WikiSection[] {
  const out: WikiSection[] = [];
  for (const kind of SECTION_KINDS) {
    const hit = sections.find((s) => s.heading !== 'Lead' && SECTION_PATTERNS[kind].some((re) => re.test(s.heading)));
    if (!hit) continue;
    const { text, truncated } = truncateAtSentence(hit.text, max);
    out.push({ kind, heading: hit.heading, text, truncated, url: `${pageUrl}#${sectionAnchor(hit.heading)}` });
  }
  return out;
}

/** Build the card's sections from a raw extract (pure; the fetcher and the tests share it). */
export function sectionsFromExtract(title: string, extract: string, now = Date.now()): WikiSections {
  const pageUrl = pageUrlFor(title);
  return { status: 'ok', title, pageUrl, sections: pickSections(parseSections(extract), pageUrl), fetchedAt: now };
}

export function extractRequestUrl(title: string): string {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    exsectionformat: 'wiki',
    redirects: '1',
    titles: title,
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  return `${ACTION_API}?${params.toString()}`;
}

interface ExtractResponse {
  query?: { pages?: Array<{ title?: string; extract?: string; missing?: boolean }> };
}

type ExtractOutcome = { kind: 'ok'; title: string; extract: string } | { kind: 'missing' } | { kind: 'network' } | { kind: 'error'; message: string };

async function fetchExtract(title: string, fetchFn: typeof fetch): Promise<ExtractOutcome> {
  let res: Response;
  try {
    res = await fetchFn(extractRequestUrl(title), { headers: { Accept: 'application/json', 'Api-User-Agent': WIKI_USER_AGENT } });
  } catch {
    return { kind: 'network' };
  }
  if (!res.ok) return { kind: 'error', message: `Wikipedia returned ${res.status}` };
  let data: ExtractResponse;
  try {
    data = (await res.json()) as ExtractResponse;
  } catch {
    return { kind: 'error', message: 'Wikipedia sent an unreadable reply' };
  }
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.extract || !page.title) return { kind: 'missing' };
  return { kind: 'ok', title: page.title, extract: page.extract };
}

export function wikiSectionsKey(species: Pick<Species, 'scientific'>): string {
  return `wiki-sections:en:${species.scientific}`;
}

/**
 * Article sections for a species: scientific name first, then the common
 * name (disambiguation pages are skipped). Cached in the IndexedDB `wiki`
 * store under its own key, so a species viewed once keeps its sections
 * offline; `force` refetches.
 */
export async function getSpeciesSections(species: Species, opts: { force?: boolean; fetchFn?: typeof fetch } = {}): Promise<WikiSectionsResult> {
  const key = wikiSectionsKey(species);
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  if (!opts.force) {
    const cached = await getWikiCache(key).catch(() => undefined);
    if (cached) return cached.data as WikiSectionsResult;
  }
  let sawNetworkError = false;
  let empty: WikiSections | null = null;
  for (const name of [species.scientific, species.common]) {
    const out = await fetchExtract(name, fetchFn);
    if (out.kind === 'network') {
      sawNetworkError = true;
      continue;
    }
    if (out.kind === 'error') return { status: 'error', message: out.message };
    if (out.kind === 'missing') continue;
    if (/may refer to:/i.test(out.extract.slice(0, 400))) continue;
    const result = sectionsFromExtract(out.title, out.extract);
    if (result.sections.length === 0) {
      empty ??= result;
      continue;
    }
    await putWikiCache({ key, fetchedAt: result.fetchedAt, data: result }).catch(() => undefined);
    return result;
  }
  if (empty) {
    await putWikiCache({ key, fetchedAt: empty.fetchedAt, data: empty }).catch(() => undefined);
    return empty;
  }
  if (sawNetworkError) {
    const cached = await getWikiCache(key).catch(() => undefined);
    return cached ? (cached.data as WikiSectionsResult) : { status: 'offline' };
  }
  return { status: 'not-found' };
}
