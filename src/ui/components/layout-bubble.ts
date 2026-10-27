import type { ListenLayout } from '../../app/settings';
import { el } from '../dom';
import { LAYOUT_OPTIONS, layoutWireframeSvg } from './layout-picker';

/**
 * Listen › layout bubble (DECISIONS.md #101): a small round button at the bottom right, above the tab bar
 * (and above the dock or Start bar when the layout has one), showing the current layout's picture. A tap
 * opens a card that grows upward with the three layouts, each with its picture, name and one line; a tap
 * on one switches at once. Escape, a tap outside, or a choice closes it. Shown only when not listening,
 * so it is never next to Stop (the view hides it).
 */
export interface LayoutBubble {
  el: HTMLElement;
  /** The layout changed (here or in Settings). */
  sync: (value: ListenLayout) => void;
  close: () => void;
  dispose: () => void;
}

const SHORT_DESCRIPTION: Record<ListenLayout, string> = {
  consolidated: 'Panel on top, results below',
  dock: 'Results fill the screen',
  focus: 'One big card for the latest bird',
};

export function layoutBubble(initial: ListenLayout, onChoose: (value: ListenLayout) => void): LayoutBubble {
  let current = initial;
  const nameOf = (v: ListenLayout) => LAYOUT_OPTIONS.find((o) => o.value === v)?.name ?? v;

  const button = el('button', { class: 'layout-bubble-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'layout-bubble-card', 'data-testid': 'layout-bubble' });
  const rows = LAYOUT_OPTIONS.map((opt) => {
    const art = el('span', { class: 'layout-bubble-art' });
    art.innerHTML = layoutWireframeSvg(opt.value, 20);
    const row = el(
      'button',
      { class: 'layout-bubble-row', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-layout': opt.value, 'data-testid': `layout-bubble-${opt.value}` },
      art,
      el('span', { class: 'layout-bubble-text' }, el('span', { class: 'layout-bubble-name' }, opt.name), el('span', { class: 'layout-bubble-desc' }, SHORT_DESCRIPTION[opt.value])),
      el('span', { class: 'layout-bubble-tick', 'aria-hidden': 'true' }, '✓'),
    );
    row.addEventListener('click', () => {
      close(true);
      if (opt.value !== current) onChoose(opt.value);
    });
    return row;
  });
  const card = el(
    'div',
    { class: 'layout-bubble-card', id: 'layout-bubble-card', hidden: true },
    el('div', { class: 'layout-bubble-title', id: 'layout-bubble-title' }, 'Listen layout'),
    el('div', { role: 'radiogroup', 'aria-labelledby': 'layout-bubble-title' }, ...rows),
  );
  const root = el('div', { class: 'layout-bubble' }, card, button);

  const render = () => {
    button.innerHTML = layoutWireframeSvg(current, 16);
    button.setAttribute('aria-label', `Listen layout: ${nameOf(current)}. Change`);
    for (const row of rows) {
      const on = row.dataset.layout === current;
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.classList.toggle('on', on);
    }
  };
  const isOpen = () => !card.hidden;
  const open = () => {
    card.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    root.classList.add('open');
    (rows.find((r) => r.dataset.layout === current) ?? rows[0]).focus();
  };
  function close(returnFocus = false) {
    if (!isOpen()) return;
    card.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    root.classList.remove('open');
    if (returnFocus) button.focus();
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close(true);
      return;
    }
    if (!isOpen() || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
  });
  // A tap anywhere else closes it.
  const onOutside = (e: PointerEvent) => {
    if (isOpen() && !root.contains(e.target as Node)) close();
  };
  document.addEventListener('pointerdown', onOutside);

  render();
  return {
    el: root,
    sync(value) {
      current = value;
      render();
    },
    close: () => close(),
    dispose() {
      document.removeEventListener('pointerdown', onOutside);
    },
  };
}
