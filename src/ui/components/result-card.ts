import { SOUND_ONLY_NOTE } from '../../species/sound-only';
import type { Species } from '../../model/labels';
import { speciesColor } from '../../species/colors';
import { heardLabel } from '../../species/recent';
import { getClip, getClipMeta } from '../../storage/db';
import type { ViewContext } from '../app';
import { el, pct } from '../dom';
import { confidenceWords } from '../confidence-text';
import { speciesHref } from '../router';
import { timeAgo } from '../status';
import { clipSlot } from './clip-player';
import { isMember } from '../../app/access';

import { birdPlaceholder, speciesThumbnail } from './bird-thumb';

export interface ResultCardOptions {
  confidence: number;
  time: number;
  /** Large variant for Focus mode (bigger photo and name). */
  large?: boolean;
  conditions?: string | null;
  /**
   * Number of lumped detections behind the card (Listen groups repeat hits of a
   * species; see src/species/recent.ts). When set, the confidence is the best
   * one and is labelled so, and "Heard N times" is shown.
   */
  heardTimes?: number;
  /** Kept against the location filter: shows the sound-only note (DECISIONS.md #93). */
  soundOnly?: boolean;
}

/**
 * Result card (DESIGN_GUIDE.md §5): thumbnail, colour dot + common name,
 * scientific name, confidence and time; members get the saved-clip button.
 * The whole card is a link to the species page.
 */
export interface ResultCardHandle {
  el: HTMLElement;
  /** Shows new numbers in the same card, so its photo and clip stay put (no rebuild, no flicker). */
  update: (opts: ResultCardOptions) => void;
  dispose: () => void;
}

export function resultCard(ctx: ViewContext, species: Species, opts: ResultCardOptions): ResultCardHandle {
  const color = speciesColor(species.scientific);
  const thumb = birdPlaceholder();
  const img = el('img', { class: 'result-thumb', alt: '', loading: 'lazy', style: 'display:none' });
  void speciesThumbnail(species).then((src) => {
    if (!src) return;
    img.src = src;
    img.style.display = '';
    thumb.style.display = 'none';
  });
  const when = el('span', { class: 'result-time tabular', 'data-testid': 'result-time' });
  const conf = el('span', { class: 'result-conf tabular' });
  const heard = el('span', { class: 'result-heard', 'data-testid': 'result-heard' });
  const heardSep = el('span', null, ' · ');
  const conditions = el('span', { class: 'muted' });
  const soundOnly = el('span', { class: 'sound-only-note', 'data-testid': 'sound-only-note' }, SOUND_ONLY_NOTE);
  const body = el(
    'span',
    { class: 'result-body' },
    el('span', { class: 'result-name' }, el('span', { class: 'swatch', style: `background:${color.css}`, 'aria-hidden': 'true' }), el('span', { class: 'result-common' }, species.common)),
    el('span', { class: 'result-sci' }, species.scientific),
    el('span', { class: 'result-meta' }, conf, heardSep, heard, ' · ', when, conditions),
    soundOnly,
  );
  const link = el('a', { class: 'result-card', href: speciesHref(species.scientific), 'data-testid': 'result-card' }, thumb, img, body);
  const root = el('div', { class: 'result-wrap' }, link);
  // Members: the species' saved clip, looked up again on each update in case a better one was saved.
  const clip = isMember(ctx.api.user) ? clipSlot(root, species.scientific, ['result-clip'], { meta: getClipMeta, clip: getClip }) : null;
  let last = '';
  const update = (o: ResultCardOptions) => {
    // Called on every analysis window; touch the DOM only when something visible changed.
    const key = JSON.stringify([o.confidence, o.time, o.large, o.conditions, o.heardTimes, o.soundOnly, timeAgo(o.time)]);
    if (key === last) return;
    last = key;
    clip?.refresh();
    const grouped = o.heardTimes != null;
    link.classList.toggle('large', !!o.large);
    conf.setAttribute('aria-label', `${grouped ? 'best ' : ''}confidence ${pct(o.confidence)}`);
    // Focus's big card says it in words too: "Very likely · best 95%" (DECISIONS.md #109).
    conf.replaceChildren(...(o.large ? [el('span', { class: 'result-words', 'data-testid': 'result-words' }, `${confidenceWords(o.confidence)} · `)] : []), ...(grouped ? [el('span', { class: 'muted result-best-label' }, 'best ')] : []), pct(o.confidence));
    heard.textContent = grouped ? heardLabel(o.heardTimes as number) : '';
    heard.hidden = !grouped;
    heardSep.hidden = !grouped;
    when.textContent = timeAgo(o.time);
    conditions.textContent = o.conditions ? ` · ${o.conditions}` : '';
    conditions.hidden = !o.conditions;
    soundOnly.hidden = !o.soundOnly;
  };
  update(opts);
  return {
    el: root,
    update,
    dispose() {
      clip?.dispose();
    },
  };
}
