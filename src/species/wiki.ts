import { getWikiCache, putWikiCache } from '../storage/db';
import type { Species } from '../model/labels';

export const WIKI_USER_AGENT = 'SabihsBirdbrain/1.0 (https://sabihs-birdbrain.vercel.app/; on-device bird ID PWA)';
const SUMMARY_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const ACTION_API = 'https://en.wikipedia.org/w/api.php';

export interface WikiImage {
  source: string;
  width: number;
  height: number;
}

export interface WikiImageInfo {
  fileName: string;
  filePageUrl: string;
  artist: string | null;
  license: string | null;
  licenseUrl: string | null;
  credit: string | null;
}

export interface WikiSummary {
  status: 'ok';
  title: string;
  displayTitle: string;
  description: string | null;
  extract: string;
  thumbnail: WikiImage | null;
  originalImage: WikiImage | null;
  pageUrl: string;
  lookedUpBy: 'scientific' | 'common';
  image: WikiImageInfo | null;
  fetchedAt: number;
}

export type WikiResult =
  | WikiSummary
  | { status: 'not-found'; searchUrl: string }
  | { status: 'disambiguation'; pageUrl: string; searchUrl: string }
  | { status: 'offline' }
  | { status: 'error'; message: string };

interface SummaryResponse {
  type?: string;
  title?: string;
  displaytitle?: string;
  description?: string;
  extract?: string;
  thumbnail?: WikiImage;
  originalimage?: WikiImage;
  content_urls?: { desktop?: { page?: string }; mobile?: { page?: string } };
}

function titleFor(name: string): string {
  return encodeURIComponent(name.trim().replace(/\s+/g, '_'));
}

export function wikiSearchUrl(query: string): string {
  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
}

/** Derive the Commons file name from a thumbnail/original image URL. */
export function imageFileName(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const parts = path.split('/').filter(Boolean);
    // /wikipedia/commons/thumb/a/ab/Name.jpg/320px-Name.jpg  -> Name.jpg
    const thumbIdx = parts.indexOf('thumb');
    const name = thumbIdx >= 0 && parts.length > thumbIdx + 3 ? parts[thumbIdx + 3] : parts[parts.length - 1];
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

type SummaryOutcome = { kind: 'ok'; data: SummaryResponse } | { kind: 'not-found' } | { kind: 'disambiguation'; data: SummaryResponse } | { kind: 'network' } | { kind: 'error'; message: string };

async function fetchSummary(title: string, fetchFn: typeof fetch): Promise<SummaryOutcome> {
  let res: Response;
  try {
    res = await fetchFn(`${SUMMARY_BASE}${titleFor(title)}?redirect=true`, {
      headers: { Accept: 'application/json', 'Api-User-Agent': WIKI_USER_AGENT },
    });
  } catch {
    return { kind: 'network' };
  }
  if (res.status === 404) return { kind: 'not-found' };
  if (!res.ok) return { kind: 'error', message: `Wikipedia returned ${res.status}` };
  const data = (await res.json()) as SummaryResponse;
  if (data.type === 'disambiguation') return { kind: 'disambiguation', data };
  if (!data.extract && !data.description) return { kind: 'not-found' };
  return { kind: 'ok', data };
}

async function fetchImageInfo(fileName: string, fetchFn: typeof fetch): Promise<WikiImageInfo | null> {
  const filePageUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName.replace(/ /g, '_'))}`;
  try {
    const params = new URLSearchParams({
      action: 'query',
      titles: `File:${fileName}`,
      prop: 'imageinfo',
      iiprop: 'extmetadata',
      iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl|Credit',
      format: 'json',
      formatversion: '2',
      origin: '*',
    });
    const res = await fetchFn(`${ACTION_API}?${params}`, { headers: { Accept: 'application/json', 'Api-User-Agent': WIKI_USER_AGENT } });
    if (!res.ok) return { fileName, filePageUrl, artist: null, license: null, licenseUrl: null, credit: null };
    const json = (await res.json()) as { query?: { pages?: Array<{ imageinfo?: Array<{ extmetadata?: Record<string, { value?: string }> }> }> } };
    const meta = json.query?.pages?.[0]?.imageinfo?.[0]?.extmetadata ?? {};
    const strip = (s?: string) => (s ? s.replace(/<[^>]+>/g, '').trim() : null);
    return {
      fileName,
      filePageUrl,
      artist: strip(meta.Artist?.value),
      license: strip(meta.LicenseShortName?.value),
      licenseUrl: strip(meta.LicenseUrl?.value),
      credit: strip(meta.Credit?.value),
    };
  } catch {
    return { fileName, filePageUrl, artist: null, license: null, licenseUrl: null, credit: null };
  }
}

function toSummary(data: SummaryResponse, lookedUpBy: 'scientific' | 'common', image: WikiImageInfo | null): WikiSummary {
  return {
    status: 'ok',
    title: data.title ?? '',
    displayTitle: (data.displaytitle ?? data.title ?? '').replace(/<[^>]+>/g, ''),
    description: data.description ?? null,
    extract: data.extract ?? '',
    thumbnail: data.thumbnail ?? null,
    originalImage: data.originalimage ?? null,
    pageUrl: data.content_urls?.mobile?.page ?? data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${titleFor(data.title ?? '')}`,
    lookedUpBy,
    image,
    fetchedAt: Date.now(),
  };
}

/**
 * Wikipedia summary for a species: scientific name first, then common name.
 * Results are cached in IndexedDB so previously viewed species work offline.
 */
export async function getSpeciesSummary(species: Species, opts: { force?: boolean; fetchFn?: typeof fetch } = {}): Promise<WikiResult> {
  const key = `wiki:en:${species.scientific}`;
  const fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  if (!opts.force) {
    const cached = await getWikiCache(key).catch(() => undefined);
    if (cached) return cached.data as WikiResult;
  }
  const attempts: Array<['scientific' | 'common', string]> = [
    ['scientific', species.scientific],
    ['common', species.common],
  ];
  let disambiguation: SummaryResponse | null = null;
  let sawNetworkError = false;
  for (const [by, name] of attempts) {
    const out = await fetchSummary(name, fetchFn);
    if (out.kind === 'ok') {
      const file = out.data.originalimage?.source ? imageFileName(out.data.originalimage.source) : out.data.thumbnail?.source ? imageFileName(out.data.thumbnail.source) : null;
      const image = file ? await fetchImageInfo(file, fetchFn) : null;
      const summary = toSummary(out.data, by, image);
      await putWikiCache({ key, fetchedAt: Date.now(), data: summary }).catch(() => undefined);
      return summary;
    }
    if (out.kind === 'disambiguation') disambiguation = out.data;
    if (out.kind === 'network') sawNetworkError = true;
    if (out.kind === 'error') return { status: 'error', message: out.message };
  }
  if (sawNetworkError) {
    const cached = await getWikiCache(key).catch(() => undefined);
    return cached ? (cached.data as WikiResult) : { status: 'offline' };
  }
  const searchUrl = wikiSearchUrl(`${species.common} ${species.scientific}`);
  if (disambiguation) {
    return { status: 'disambiguation', pageUrl: disambiguation.content_urls?.mobile?.page ?? disambiguation.content_urls?.desktop?.page ?? searchUrl, searchUrl };
  }
  return { status: 'not-found', searchUrl };
}
