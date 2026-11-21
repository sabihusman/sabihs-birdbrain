import type { ListenLayout } from '../../app/settings';
import { el } from '../dom';
import { LAYOUT_OPTIONS, layoutArt } from './layout-picker';

/**
 * Listen › layout button (DECISIONS.md #101, relabelled and given a sheet in #131): a pill at the bottom right,
 * above the tab bar (and above Focus's Start bar), that says "Layout: Focus" next to the layout's picture. A tap
 * opens a sheet from the bottom over a dimmed page: the layouts (BirdAmp too for members, #110), each with its
 * picture, name and one line, a ✕ and Done. A tap on a layout switches the page behind at once and the sheet stays
 * open so the tick is seen; Done, ✕, Escape or a tap on the dimmed page closes it. Shown only when not listening,
 * so it is never next to Stop (the view hides it).
 *
 * The sheet is appended to <body> while open, like the app's other dialogs, so it covers the header and tab bar.
 */
export interface LayoutBubble {
  el: HTMLElement;
  /** The layout changed (here or in Settings). */
  sync: (value: ListenLayout) => void;
  close: () => void;
  /** Show or hide the members-only rows (BirdAmp, DECISIONS.md #110). */
  setMember: (member: boolean) => void;
  dispose: () => void;
}

const SHORT_DESCRIPTION: Record<ListenLayout, string> = {
  consolidated: 'Panel on top, results below',
  focus: 'One big card for the latest bird',
  birdamp: 'Winamp player + library',
};

export const LAYOUT_SHEET_INTRO = 'How the Listen screen is arranged. Change it any time.';

/** The words on the button: "Layout: Focus". */
export function layoutButtonText(name: string): string {
  return `Layout: ${name}`;
}

export function layoutBubble(initial: ListenLayout, onChoose: (value: ListenLayout) => void, member = false): LayoutBubble {
  let current = initial;
  let isMember = member;
  const nameOf = (v: ListenLayout) => LAYOUT_OPTIONS.find((o) => o.value === v)?.name ?? v;

  const buttonArt = el('span', { class: 'layout-bubble-btn-art', 'aria-hidden': 'true' });
  const buttonText = el('span', { class: 'layout-bubble-btn-text' }, '');
  const button = el('button', { class: 'layout-bubble-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'layout-bubble-card', 'data-testid': 'layout-bubble' }, buttonArt, buttonText);
  const rows = LAYOUT_OPTIONS.map((opt) => {
    const art = el('span', { class: 'layout-bubble-art' });
    art.innerHTML = layoutArt(opt.value, 20);
    const row = el(
      'button',
      { class: 'layout-bubble-row', type: 'button', role: 'radio', 'aria-checked': 'false', 'data-layout': opt.value, 'data-testid': `layout-bubble-${opt.value}` },
      art,
      el('span', { class: 'layout-bubble-text' }, el('span', { class: 'layout-bubble-name' }, opt.name), el('span', { class: 'layout-bubble-desc' }, SHORT_DESCRIPTION[opt.value])),
      el('span', { class: 'layout-bubble-tick', 'aria-hidden': 'true' }, '✓'),
    );
    row.addEventListener('click', () => {
      if (opt.value === current) return;
      current = opt.value;
      render();
      onChoose(opt.value);
    });
    return row;
  });
  const closeBtn = el('button', { class: 'layout-sheet-close', type: 'button', 'aria-label': 'Close', 'data-testid': 'layout-sheet-close' }, el('span', { 'aria-hidden': 'true' }, '✕'));
  const doneBtn = el('button', { class: 'btn primary block', type: 'button', 'data-testid': 'layout-sheet-done' }, 'Done');
  const sheet = el(
    'div',
    { class: 'layout-sheet', id: 'layout-bubble-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'layout-bubble-title', 'data-testid': 'layout-sheet' },
    el('div', { class: 'layout-sheet-grab', 'aria-hidden': 'true' }),
    el('div', { class: 'layout-sheet-top' }, el('h2', { class: 'layout-sheet-title', id: 'layout-bubble-title' }, 'Listen layout'), closeBtn),
    el('p', { class: 'small muted layout-sheet-intro' }, LAYOUT_SHEET_INTRO),
    el('div', { class: 'layout-sheet-rows', role: 'radiogroup', 'aria-labelledby': 'layout-bubble-title' }, ...rows),
    doneBtn,
  );
  const backdrop = el('div', { class: 'layout-sheet-backdrop', 'data-testid': 'layout-sheet-backdrop' }, sheet);
  const root = el('div', { class: 'layout-bubble' }, button);

  const render = () => {
    buttonArt.innerHTML = layoutArt(current, 16);
    button.classList.toggle('bolt', current === 'birdamp');
    buttonText.textContent = layoutButtonText(nameOf(current));
    button.setAttribute('aria-label', `Listen layout: ${nameOf(current)}. Change`);
    for (const row of rows) {
      const on = row.dataset.layout === current;
      row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.tabIndex = on ? 0 : -1;
      row.classList.toggle('on', on);
      row.hidden = !isMember && LAYOUT_OPTIONS.find((o) => o.value === row.dataset.layout)?.membersOnly === true;
    }
  };
  const isOpen = () => backdrop.isConnected;
  const open = () => {
    document.body.appendChild(backdrop);
    button.setAttribute('aria-expanded', 'true');
    root.classList.add('open');
    (rows.find((r) => r.dataset.layout === current) ?? rows[0]).focus();
  };
  function close(returnFocus = false) {
    if (!isOpen()) return;
    backdrop.remove();
    button.setAttribute('aria-expanded', 'false');
    root.classList.remove('open');
    if (returnFocus && button.isConnected) button.focus();
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  closeBtn.addEventListener('click', () => close(true));
  doneBtn.addEventListener('click', () => close(true));
  // A tap on the dimmed page (not on the sheet) closes it.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    const visible = rows.filter((r) => !r.hidden);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const i = visible.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      e.preventDefault();
      visible[(i + (e.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length].focus();
      return;
    }
    // Tab stays inside the sheet while it is open: ✕, the layouts, Done.
    if (e.key === 'Tab') {
      const stops: HTMLElement[] = [closeBtn, ...visible.filter((r) => r.tabIndex === 0 || r === document.activeElement), doneBtn];
      const i = stops.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      stops[(Math.max(0, i) + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
    }
  });

  render();
  return {
    el: root,
    sync(value) {
      current = value;
      render();
    },
    close: () => close(),
    setMember(m) {
      isMember = m;
      render();
    },
    dispose() {
      backdrop.remove();
    },
  };
}
