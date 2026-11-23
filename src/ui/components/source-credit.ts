import { BIRDNET_CREDIT, BIRDNET_V3_CREDIT, type Credit } from '../credits';
import type { ModelId } from '../../model/v3';
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

/** The one BirdNET line at the bottom of the Listen screen, in every layout, for the model that runs. */
export function birdnetCredit(model: ModelId = 'v2.4'): HTMLElement {
  const root = el('p', { class: 'source-credit', 'data-testid': 'birdnet-credit' });
  setBirdnetCredit(root, model);
  return root;
}

/** Rewrite the credit line in place when the model changes (DECISIONS.md #133). */
export function setBirdnetCredit(root: HTMLElement, model: ModelId): void {
  const c = model === 'v3.0' ? BIRDNET_V3_CREDIT : BIRDNET_CREDIT;
  root.replaceChildren(c.label, link(c.linkText, c.url), c.rest, link(c.licenceText, c.licenceUrl));
}
