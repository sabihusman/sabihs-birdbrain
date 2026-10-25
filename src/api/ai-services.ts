import { API_BASE_URL } from './config';

/**
 * Which AI services a question can go to, as the server reports them (`GET /v1/ai-services`, DECISIONS.md #90):
 * company and service names in the order they are tried, never model names. The privacy text and How it works
 * name them from here, so switching provider on the server needs no app change.
 *
 * Asked only when a page that names them is opened, at most once per page load; the last answer is kept on the
 * phone for offline use. With no answer yet the text says "an AI service".
 */
export const AI_SERVICES_KEY = 'birdbrain.ai-services.v1';
const MAX_SERVICES = 5;
const MAX_LABEL = 40;

export function parseAiServices(raw: unknown): string[] | null {
  const list = (raw as { services?: unknown } | null)?.services;
  if (!Array.isArray(list) || list.length > MAX_SERVICES) return null;
  if (!list.every((s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_LABEL)) return null;
  return list.map((s: string) => s.trim());
}

/** "Ollama Cloud", "Ollama Cloud, or Google Gemini as backup", "A, with B then C as backups"; "an AI service" when unknown or none. */
export function describeAiServices(list: string[] | null): string {
  if (!list || list.length === 0) return 'an AI service';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]}, or ${list[1]} as backup`;
  return `${list[0]}, with ${list.slice(1).join(' then ')} as backups`;
}

export function storedAiServices(storage: Storage | null = safeLocalStorage()): string[] | null {
  try {
    const raw = storage?.getItem(AI_SERVICES_KEY);
    return raw ? parseAiServices(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

let pending: Promise<string[] | null> | null = null;

/** The server's current list (stored for next time), or the stored one when the server can't be reached. */
export function refreshAiServices(fetchFn: typeof fetch = (i, init) => fetch(i, init), storage: Storage | null = safeLocalStorage(), baseUrl = API_BASE_URL): Promise<string[] | null> {
  pending ??= (async () => {
    try {
      const res = await fetchFn(`${baseUrl}/v1/ai-services`, { headers: { Accept: 'application/json' } });
      const list = res.ok ? parseAiServices(await res.json()) : null;
      if (!list) return giveUp(storage);
      try {
        storage?.setItem(AI_SERVICES_KEY, JSON.stringify({ services: list }));
      } catch {
        /* storage unavailable */
      }
      return list;
    } catch {
      return giveUp(storage);
    }
  })();
  return pending;
}

/** No answer: use the stored list, and let the next page that names the services ask again. */
function giveUp(storage: Storage | null): string[] | null {
  pending = null;
  return storedAiServices(storage);
}

/** Tests only: forget this page load's request. */
export function resetAiServicesForTest(): void {
  pending = null;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
