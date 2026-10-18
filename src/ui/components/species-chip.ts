import type { Species } from '../../model/labels';
import { speciesColor } from '../../species/colors';
import { el, pct } from '../dom';
import { speciesHref } from '../router';

export interface ChipOptions {
  confidence?: number;
  outOfRange?: boolean;
  subtitle?: string;
  link?: boolean;
}

/** Species name next to its fixed colour; optionally with a confidence bar. Always shows the name. */
export function speciesChip(species: Species, opts: ChipOptions = {}): HTMLElement {
  const color = speciesColor(species.scientific);
  const inner = [
    el('span', { class: 'swatch', style: `background:${color.css}`, 'aria-hidden': 'true' }),
    el('span', { class: 'chip-names' }, el('span', { class: 'chip-common' }, species.common), el('span', { class: 'chip-sci' }, species.scientific)),
    opts.confidence != null
      ? el(
          'span',
          { class: 'chip-conf', 'aria-label': `confidence ${pct(opts.confidence)}` },
          el('span', { class: 'conf-bar' }, el('span', { class: 'conf-fill', style: `width:${Math.round(opts.confidence * 100)}%;background:${color.css}` })),
          el('span', { class: 'conf-text' }, pct(opts.confidence)),
        )
      : null,
    opts.subtitle ? el('span', { class: 'chip-sub' }, opts.subtitle) : null,
  ];
  const cls = `chip${opts.outOfRange ? ' out-of-range' : ''}`;
  if (opts.link === false) return el('div', { class: cls }, ...inner);
  return el('a', { class: cls, href: speciesHref(species.scientific) }, ...inner);
}
