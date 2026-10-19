const USER_AGENT = 'SabihsBirdbrainAPI/1.0 (https://github.com/sabihusman/sabihs-birdbrain)';
const SUMMARY_BASE = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
/** Wikipedia text is untrusted input for the model; keep it bounded. */
export const MAX_EXTRACT_CHARS = 6000;

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
}

export type WikiFetcher = (scientific: string, common: string) => Promise<WikiSummary | null>;

interface SummaryResponse {
  type?: string;
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

async function fetchOne(title: string, signal: AbortSignal): Promise<WikiSummary | null | 'disambiguation'> {
  const res = await fetch(`${SUMMARY_BASE}${encodeURIComponent(title.trim().replace(/\s+/g, '_'))}?redirect=true`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wikipedia responded ${res.status}`);
  const data = (await res.json()) as SummaryResponse;
  if (data.type === 'disambiguation') return 'disambiguation';
  if (!data.extract) return null;
  return {
    title: data.title ?? title,
    // eslint-disable-next-line no-control-regex
    extract: data.extract.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, MAX_EXTRACT_CHARS),
    url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`,
  };
}

/** Scientific name first, then the common name. */
export const fetchWikipediaSummary: WikiFetcher = async (scientific, common) => {
  const signal = AbortSignal.timeout(8000);
  for (const name of [scientific, common]) {
    const out = await fetchOne(name, signal);
    if (out && out !== 'disambiguation') return out;
  }
  return null;
};
