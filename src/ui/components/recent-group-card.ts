import { SOUND_ONLY_NOTE } from '../../species/sound-only';
import type { Species } from '../../model/labels';
import { isMember } from '../../app/access';
import { speciesColor } from '../../species/colors';
import { describeGroup, detectionTimeLabel, heardLabel, type SpeciesGroup } from '../../species/recent';
import { getClip } from '../../storage/db';
import type { ViewContext } from '../app';
import { el, pct } from '../dom';
import { speciesHref } from '../router';
import { clipPlayer } from './clip-player';

export interface RecentGroupCardOptions {
  /** Whether the card starts expanded (the view keeps the set of open species). */
  expanded: boolean;
  /** Called after a tap toggles the card; the view re-renders from its state. */
  onToggle: (key: string) => void;
}

/**
 * One species in Listen → "Recent sightings": name, scientific name, best
 * confidence ("best"), "Heard N times" (lumped detections) and the time last
 * heard. The whole card is a button (≥ 44 px) with `aria-expanded`; tapping it
 * shows the lumped detections, newest first, each with its time or time range,
 * hit count and best confidence. Members also get the saved clip (the best one
 * kept for the species). The species page stays one tap away via its link.
 */
export function recentGroupCard(ctx: ViewContext, g: SpeciesGroup<Species>, opts: RecentGroupCardOptions): { el: HTMLElement; dispose: () => void } {
  const color = speciesColor(g.species.scientific);
  const disposers: Array<() => void> = [];
  const panelId = `recent-${g.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const lastLabel = new Date(g.lastHeard).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  const head = el(
    'button',
    {
      class: 'recent-card-head',
      type: 'button',
      'aria-expanded': opts.expanded ? 'true' : 'false',
      'aria-controls': panelId,
      'aria-label': describeGroup(g.species.common, g),
      'data-testid': 'recent-card',
      'data-species': g.key,
    },
    el(
      'span',
      { class: 'recent-card-main' },
      el('span', { class: 'result-name' }, el('span', { class: 'swatch', style: `background:${color.css}`, 'aria-hidden': 'true' }), el('span', { class: 'result-common' }, g.species.common)),
      el('span', { class: 'result-sci' }, g.species.scientific),
      el(
        'span',
        { class: 'recent-card-meta' },
        el('span', { class: 'recent-best tabular' }, el('span', { class: 'muted' }, 'best '), pct(g.best)),
        el('span', { class: 'muted', 'aria-hidden': 'true' }, ' · '),
        el('span', { class: 'recent-count', 'data-testid': 'recent-count' }, heardLabel(g.detections.length)),
        el('span', { class: 'muted', 'aria-hidden': 'true' }, ' · '),
        el('span', { class: 'recent-last tabular' }, el('span', { class: 'muted' }, 'last '), lastLabel),
      ),
      g.soundOnly ? el('span', { class: 'sound-only-note', 'data-testid': 'sound-only-note' }, SOUND_ONLY_NOTE) : null,
    ),
    el('span', { class: 'recent-chevron', 'aria-hidden': 'true' }, '›'),
  );
  head.addEventListener('click', () => opts.onToggle(g.key));

  const rows = el('ul', { class: 'recent-rows', id: panelId, 'data-testid': 'recent-rows' });
  if (opts.expanded) {
    for (const d of g.detections) {
      const hits = d.hits === 1 ? '1 hit' : `${d.hits} hits`;
      rows.appendChild(el('li', { class: 'recent-row' }, el('span', { class: 'recent-row-time tabular' }, detectionTimeLabel(d)), el('span', { class: 'recent-row-meta muted' }, `${hits} · best ${pct(d.best)}`)));
    }
    rows.appendChild(el('li', { class: 'recent-row recent-row-link' }, el('a', { href: speciesHref(g.species.scientific) }, 'Species page ›')));
  } else {
    rows.hidden = true;
  }

  const root = el('div', { class: `recent-card${opts.expanded ? ' open' : ''}`, 'data-testid': 'recent-group' }, head, rows);
  if (isMember(ctx.api.user)) {
    void getClip(g.species.scientific)
      .then((clip) => {
        if (!clip) return;
        const player = clipPlayer(clip);
        disposers.push(player.dispose);
        player.el.classList.add('result-clip', 'recent-clip');
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
