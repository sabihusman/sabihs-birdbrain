import type { Species } from '../../model/labels';
import { speciesColor } from '../../species/colors';
import { heardLabel } from '../../species/recent';
import { getSpeciesSummary } from '../../species/wiki';
import { getClip } from '../../storage/db';
import type { ViewContext } from '../app';
import { el, pct } from '../dom';
import { speciesHref } from '../router';
import { timeAgo } from '../status';
import { clipPlayer } from './clip-player';
import { isMember } from '../../app/access';

/** Sage tile with a bird outline, shown until a Wikipedia thumbnail is available (or when there is none). */
export function birdPlaceholder(): HTMLElement {
  const box = el('span', { class: 'result-thumb placeholder', 'aria-hidden': 'true' });
  box.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20c2-8 8-13 16-14-1 8-6 14-14 14H4zM4 20l6-6"/></svg>';
  return box;
}

const thumbCache = new Map<string, Promise<string | null>>();
/** Thumbnail URL from the cached Wikipedia summary; fetched once per species per session, never blocks the card. */
export function speciesThumbnail(species: Species): Promise<string | null> {
  let p = thumbCache.get(species.scientific);
  if (!p) {
    p = getSpeciesSummary(species)
      .then((r) => (r.status === 'ok' && r.thumbnail ? r.thumbnail.source : null))
      .catch(() => null);
    thumbCache.set(species.scientific, p);
  }
  return p;
}

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
}

/**
 * Result card (DESIGN_GUIDE.md §5): thumbnail, colour dot + common name,
 * scientific name, confidence and time; members get the saved-clip button.
 * The whole card is a link to the species page.
 */
export function resultCard(ctx: ViewContext, species: Species, opts: ResultCardOptions): { el: HTMLElement; dispose: () => void } {
  const color = speciesColor(species.scientific);
  const disposers: Array<() => void> = [];
  const thumb = birdPlaceholder();
  const img = el('img', { class: 'result-thumb', alt: '', loading: 'lazy', style: 'display:none' });
  void speciesThumbnail(species).then((src) => {
    if (!src) return;
    img.src = src;
    img.style.display = '';
    thumb.style.display = 'none';
  });
  const when = el('span', { class: 'result-time tabular', 'data-testid': 'result-time' }, timeAgo(opts.time));
  const grouped = opts.heardTimes != null;
  const conf = el(
    'span',
    { class: 'result-conf tabular', 'aria-label': `${grouped ? 'best ' : ''}confidence ${pct(opts.confidence)}` },
    grouped ? el('span', { class: 'muted result-best-label' }, 'best ') : null,
    pct(opts.confidence),
  );
  const heard = grouped ? el('span', { class: 'result-heard', 'data-testid': 'result-heard' }, heardLabel(opts.heardTimes as number)) : null;
  const body = el(
    'span',
    { class: 'result-body' },
    el('span', { class: 'result-name' }, el('span', { class: 'swatch', style: `background:${color.css}`, 'aria-hidden': 'true' }), el('span', { class: 'result-common' }, species.common)),
    el('span', { class: 'result-sci' }, species.scientific),
    el('span', { class: 'result-meta' }, conf, heard ? ' · ' : null, heard, ' · ', when, opts.conditions ? el('span', { class: 'muted' }, ` · ${opts.conditions}`) : null),
  );
  const link = el('a', { class: `result-card${opts.large ? ' large' : ''}`, href: speciesHref(species.scientific), 'data-testid': 'result-card' }, thumb, img, body);
  const root = el('div', { class: 'result-wrap' }, link);
  if (isMember(ctx.api.user)) {
    void getClip(species.scientific)
      .then((clip) => {
        if (!clip) return;
        const player = clipPlayer(clip);
        disposers.push(player.dispose);
        player.el.classList.add('result-clip');
        root.appendChild(player.el);
      })
      .catch(() => undefined);
  }
  return {
    el: root,
    dispose() {
      for (const d of disposers) d();
    },
  };
}
