import { BIRDNET_CREDIT, type Credit } from '../credits';
import { el } from '../dom';

const link = (text: string, href: string) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

/**
 * The credit line under an "Ask about this bird" answer, for the sources that
 * answer used (DECISIONS.md #66). Returns null when there is nothing to credit,
 * so the caller renders nothing. 75% of the answer's text size (.answer-credit).
 */
export function answerCredits(credits: ReadonlyArray<Credit>): HTMLElement | null {
  if (!credits.length) return null;
  return el('p', { class: 'answer-credit', 'data-testid': 'answer-credits' }, ...credits.flatMap((c, i) => [i ? ' · ' : '', c.label, link(c.linkText, c.url)]));
}

/** The one BirdNET line at the bottom of the Listen screen, in every layout. */
export function birdnetCredit(): HTMLElement {
  const c = BIRDNET_CREDIT;
  return el('p', { class: 'source-credit', 'data-testid': 'birdnet-credit' }, c.label, link(c.linkText, c.url), c.rest, link(c.licenceText, c.licenceUrl));
}
