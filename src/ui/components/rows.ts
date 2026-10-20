import { el } from '../dom';

/**
 * Grouped rows for Settings (DESIGN_GUIDE.md §5): a titled group of full-width rows,
 * each one line of label plus an optional muted line under it. Rows replace the stacks
 * of paragraphs and buttons that filled the Account card on a phone.
 *
 * Every tappable row is at least 44 px tall and keeps the focus ring (§8).
 */
export function rowGroup(title: string | null, ...rows: Array<Node | null>): HTMLElement {
  return el('div', { class: 'row-group' }, title ? el('h3', { class: 'row-group-title' }, title) : null, el('div', { class: 'rows' }, ...rows));
}

function label(text: string, hint?: string): HTMLElement {
  return el('span', { class: 'row-label' }, el('span', null, text), hint ? el('span', { class: 'row-hint small muted' }, hint) : null);
}

/** A row that does something when tapped: a button with a chevron. */
export function actionRow(text: string, opts: { hint?: string; testId?: string; onClick: () => void; danger?: boolean; disabled?: boolean; disabledNote?: string }): HTMLElement {
  const row = el(
    'button',
    {
      class: `row-item${opts.danger ? ' danger' : ''}`,
      type: 'button',
      'data-testid': opts.testId,
      disabled: opts.disabled ?? false,
      'aria-disabled': opts.disabled ? 'true' : null,
    },
    label(text, opts.disabled ? (opts.disabledNote ?? opts.hint) : opts.hint),
    el('span', { class: 'row-chevron', 'aria-hidden': 'true' }, opts.disabled ? '' : '›'),
  );
  if (!opts.disabled) row.addEventListener('click', opts.onClick);
  return row;
}

/** A row that holds a link, for a page we already have. */
export function linkRow(text: string, href: string, opts: { hint?: string; testId?: string } = {}): HTMLElement {
  return el('a', { class: 'row-item', href, 'data-testid': opts.testId }, label(text, opts.hint), el('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'));
}

/** A row with a switch on the right. The caller owns the checkbox. */
export function switchRow(text: string, input: HTMLInputElement, opts: { hint?: string; testId?: string } = {}): HTMLElement {
  return el('label', { class: 'row-item row-switch', 'data-testid': opts.testId }, label(text, opts.hint), input);
}

/** A row that is only text, for a status line inside a group. */
export function textRow(text: string, opts: { testId?: string } = {}): HTMLElement {
  return el('div', { class: 'row-item row-static small muted', 'data-testid': opts.testId }, text);
}
