import { el } from '../dom';

/** One answer in a choice sheet. */
export interface Choice {
  id: string;
  label: string;
  /** "danger" for an answer that deletes; "plain" for Cancel and the like. */
  tone?: 'danger' | 'plain';
}

let sheetCount = 0;

/**
 * A question with two or more answers, as a sheet from the bottom of the screen (the Listen layout sheet's look,
 * DECISIONS.md #131): used where `confirm()`'s OK / Cancel cannot say which of two deletions is meant (DECISIONS.md
 * #138). Resolves with the chosen id, or null for Cancel, ✕, Escape or a tap on the dimmed page. Appended to <body>, so
 * it is never turned by ⇅ Flip.
 */
export function askChoice(opts: { title: string; lines: string[]; choices: Choice[]; testid?: string }): Promise<string | null> {
  const titleId = `choice-sheet-title-${++sheetCount}`;
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise((resolve) => {
    const buttons = opts.choices.map((c) => {
      const b = el('button', { class: `btn block${c.tone === 'danger' ? ' danger' : ''}`, type: 'button', 'data-choice': c.id, 'data-testid': `choice-${c.id}` }, c.label);
      b.addEventListener('click', () => done(c.id));
      return b;
    });
    const closeBtn = el('button', { class: 'layout-sheet-close', type: 'button', 'aria-label': 'Close' }, el('span', { 'aria-hidden': 'true' }, '✕'));
    closeBtn.addEventListener('click', () => done(null));
    const sheet = el(
      'div',
      { class: 'layout-sheet choice-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'data-testid': opts.testid ?? 'choice-sheet' },
      el('div', { class: 'layout-sheet-grab', 'aria-hidden': 'true' }),
      el('div', { class: 'layout-sheet-top' }, el('h2', { class: 'layout-sheet-title', id: titleId }, opts.title), closeBtn),
      ...opts.lines.map((line) => el('p', { class: 'small layout-sheet-intro' }, line)),
      el('div', { class: 'stack choice-sheet-buttons' }, ...buttons),
    );
    const backdrop = el('div', { class: 'layout-sheet-backdrop' }, sheet);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) done(null);
    });
    sheet.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done(null);
      }
      // Keep Tab inside the sheet while it is open.
      if (e.key === 'Tab') {
        const stops = [closeBtn, ...buttons];
        const at = stops.indexOf(document.activeElement as HTMLButtonElement);
        let next = (at + 1) % stops.length;
        if (e.shiftKey) next = at <= 0 ? stops.length - 1 : at - 1;
        e.preventDefault();
        stops[next].focus();
      }
    });
    function done(id: string | null) {
      backdrop.remove();
      if (returnTo?.isConnected) returnTo.focus();
      resolve(id);
    }
    document.body.appendChild(backdrop);
    // The safe answer first under the finger: focus starts on the last (Cancel) button.
    buttons[buttons.length - 1]?.focus();
  });
}
