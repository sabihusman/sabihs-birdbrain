import { el } from '../dom';

/** A button label and the exact text of the card heading it scrolls to. */
export type Jump = readonly [label: string, heading: string];

/** The card whose `h2` reads `heading`, or null when that card is not on the page (yet). */
export function jumpTarget(scope: ParentNode, heading: string): { section: HTMLElement; title: HTMLElement } | null {
  for (const h of scope.querySelectorAll<HTMLElement>('h2')) {
    if (h.textContent?.trim() !== heading) continue;
    return { section: h.closest<HTMLElement>('section') ?? h, title: h };
  }
  return null;
}

/**
 * A row of buttons at the top of a long page, one per card (Settings, DECISIONS.md #131). A tap scrolls to that
 * card and moves focus to its heading; nothing is hidden or folded. The row scrolls sideways on a phone and wraps
 * on a computer.
 */
export function jumpRow(scope: () => ParentNode, jumps: readonly Jump[], label: string): HTMLElement {
  const nav = el('nav', { class: 'jump-row', 'aria-label': label, 'data-testid': 'jump-row' });
  for (const [text, heading] of jumps) {
    const b = el('button', { class: 'jump-chip', type: 'button', 'data-jump': heading }, text);
    b.addEventListener('click', () => {
      const target = jumpTarget(scope(), heading);
      if (!target) return;
      const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.section.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
      target.title.tabIndex = -1;
      target.title.focus({ preventScroll: true });
    });
    nav.appendChild(b);
  }
  return nav;
}
