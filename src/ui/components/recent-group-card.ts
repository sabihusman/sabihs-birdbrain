import { SOUND_ONLY_NOTE } from '../../species/sound-only';
import type { Species } from '../../model/labels';
import { isMember } from '../../app/access';
import { speciesColor } from '../../species/colors';
import { describeGroup, detectionTimeLabel, heardLabel, type SpeciesGroup } from '../../species/recent';
import { getClip, getClipMeta } from '../../storage/db';
import type { ViewContext } from '../app';
import { el, pct } from '../dom';
import { speciesHref } from '../router';
import { clipSlot } from './clip-player';

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
export interface RecentGroupCardHandle {
  el: HTMLElement;
  /** Shows the group's new numbers (and open or closed state) in the same card; the clip player stays. */
  update: (g: SpeciesGroup<Species>, expanded: boolean) => void;
  dispose: () => void;
}

export function recentGroupCard(ctx: ViewContext, g: SpeciesGroup<Species>, opts: RecentGroupCardOptions): RecentGroupCardHandle {
  const color = speciesColor(g.species.scientific);
  const panelId = `recent-${g.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  const best = el('span', { class: 'recent-best tabular' });
  const count = el('span', { class: 'recent-count', 'data-testid': 'recent-count' });
  const last = el('span', { class: 'recent-last tabular' });
  const soundOnly = el('span', { class: 'sound-only-note', 'data-testid': 'sound-only-note' }, SOUND_ONLY_NOTE);
  const head = el(
    'button',
    {
      class: 'recent-card-head',
      type: 'button',
      'aria-controls': panelId,
      'data-testid': 'recent-card',
      'data-species': g.key,
    },
    el(
      'span',
      { class: 'recent-card-main' },
      el('span', { class: 'result-name' }, el('span', { class: 'swatch', style: `background:${color.css}`, 'aria-hidden': 'true' }), el('span', { class: 'result-common' }, g.species.common)),
      el('span', { class: 'result-sci' }, g.species.scientific),
      el('span', { class: 'recent-card-meta' }, best, el('span', { class: 'muted', 'aria-hidden': 'true' }, ' · '), count, el('span', { class: 'muted', 'aria-hidden': 'true' }, ' · '), last),
      soundOnly,
    ),
    el('span', { class: 'recent-chevron', 'aria-hidden': 'true' }, '›'),
  );
  head.addEventListener('click', () => opts.onToggle(g.key));

  const rows = el('ul', { class: 'recent-rows', id: panelId, 'data-testid': 'recent-rows' });
  const root = el('div', { class: 'recent-card', 'data-testid': 'recent-group' }, head, rows);

  // Members: the species' saved clip, looked up again on each update in case a better one was saved.
  const clip = isMember(ctx.api.user) ? clipSlot(root, g.species.scientific, ['result-clip', 'recent-clip'], { meta: getClipMeta, clip: getClip }) : null;
  let lastKey = '';
  const update = (group: SpeciesGroup<Species>, expanded: boolean) => {
    // Called on every analysis window; touch the DOM only when something visible changed.
    const key = JSON.stringify([group.best, group.lastHeard, group.soundOnly, expanded, group.detections.map((d) => [d.start, d.end, d.hits, d.best])]);
    if (key === lastKey) return;
    lastKey = key;
    clip?.refresh();
    const lastLabel = new Date(group.lastHeard).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    head.setAttribute('aria-label', describeGroup(group.species.common, group));
    best.replaceChildren(el('span', { class: 'muted' }, 'best '), pct(group.best));
    count.textContent = heardLabel(group.detections.length);
    last.replaceChildren(el('span', { class: 'muted' }, 'last '), lastLabel);
    soundOnly.hidden = !group.soundOnly;
    root.classList.toggle('open', expanded);
    rows.hidden = !expanded;
    if (!expanded) {
      rows.replaceChildren();
      return;
    }
    rows.replaceChildren(
      ...group.detections.map((d) => {
        const hits = d.hits === 1 ? '1 hit' : `${d.hits} hits`;
        return el('li', { class: 'recent-row' }, el('span', { class: 'recent-row-time tabular' }, detectionTimeLabel(d)), el('span', { class: 'recent-row-meta muted' }, `${hits} · best ${pct(d.best)}`));
      }),
      el('li', { class: 'recent-row recent-row-link' }, el('a', { href: speciesHref(group.species.scientific) }, 'Species page ›')),
    );
  };
  update(g, opts.expanded);

  return {
    el: root,
    update,
    dispose() {
      clip?.dispose();
    },
  };
}
