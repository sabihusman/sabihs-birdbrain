/**
 * Housekeeping for the `birdnet-models-v2.4` Cache API bucket (DECISIONS.md #56).
 *
 * The bucket holds only BirdNET files, so anything in it that does not belong to the
 * base URL this build loads from is a leftover: either the old copies served from the
 * front end before the model moved to the API host, or a previous model version. Each
 * set is ~78 MiB of a phone's storage, so the worker deletes them the first time it
 * loads the model from the new place.
 */

/** Entries in the model cache that no longer belong to `baseUrl`. */
export function staleModelEntries(urls: readonly string[], baseUrl: string): string[] {
  // An absolute base (production) is compared whole; a relative one (dev, preview and
  // the Playwright run) by path, so the comparison needs no page origin.
  if (/^https?:\/\//i.test(baseUrl)) return urls.filter((u) => !u.startsWith(baseUrl));
  const base = baseUrl.startsWith('/') ? baseUrl : `/${baseUrl}`;
  return urls.filter((u) => !pathOf(u).startsWith(base));
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
