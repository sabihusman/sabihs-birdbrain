/**
 * Data-source credits (DECISIONS.md #66). A source is credited, in the small
 * credit style, on every page that displays its data and nowhere else:
 * eBird and NatureServe Explorer under an "Ask about this bird" answer that
 * used them, BirdNET on the Listen screen that identifies with it.
 */

export interface Credit {
  /** The words before the link, e.g. "Local sightings in answers: ". */
  label: string;
  /** The link text, e.g. "eBird.org". */
  linkText: string;
  url: string;
}

/** The eBird API terms ask for "eBird.org" as the credited source, with a link back to eBird.org. */
export const EBIRD_CREDIT: Credit = { label: 'Local sightings in answers: ', linkText: 'eBird.org', url: 'https://ebird.org' };
/** NatureServe Explorer data is CC BY: credit the creator, with a link to the application. */
export const NATURESERVE_CREDIT: Credit = { label: 'Conservation status: ', linkText: 'NatureServe Explorer', url: 'https://explorer.natureserve.org' };

/** The BirdNET credit line on Listen: names and licence as in public/models/birdnet-v2.4/LICENSE.md. */
export const BIRDNET_CREDIT = {
  label: 'Bird ID: ',
  linkText: 'BirdNET',
  url: 'https://birdnet.cornell.edu',
  rest: ', Cornell Lab of Ornithology and Chemnitz University of Technology · ',
  licenceText: 'CC BY-NC-SA 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
} as const;

/** Match on the name the server uses (server/src/ask.ts SOURCE_NAMES) or on the link's host, so a renamed label still credits. */
const isEbird = (s: { name: string; url: string }) => /\bebird\b/i.test(s.name) || /(^|\.)ebird\.org$/i.test(hostOf(s.url));
const isNatureServe = (s: { name: string; url: string }) => /natureserve/i.test(s.name) || /(^|\.)natureserve\.org$/i.test(hostOf(s.url));

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The credits an answer owes, from the `sources` it lists: eBird when eBird
 * was used, NatureServe Explorer when it was, in that order; nothing for an
 * answer from Wikipedia alone (Wikipedia keeps its own link in the source
 * line). Never a credit for a source the answer did not use.
 */
export function creditsFor(sources: ReadonlyArray<{ name: string; url: string }> | null | undefined): Credit[] {
  const out: Credit[] = [];
  if (!sources?.length) return out;
  if (sources.some(isEbird)) out.push(EBIRD_CREDIT);
  if (sources.some(isNatureServe)) out.push(NATURESERVE_CREDIT);
  return out;
}

/** The credit line as plain text, e.g. "Local sightings in answers: eBird.org · Conservation status: NatureServe Explorer". */
export function creditText(credits: ReadonlyArray<Credit>): string {
  return credits.map((c) => `${c.label}${c.linkText}`).join(' · ');
}
