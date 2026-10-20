import { el } from '../dom';

/**
 * A collapsed section: native `<details>`/`<summary>`, so Enter and Space work and
 * screen readers announce the expanded state without any of our own ARIA
 * (DESIGN_GUIDE.md §5, §8). The summary is at least 44 px tall and shows the focus
 * ring; the chevron animation is dropped under prefers-reduced-motion in styles.css.
 *
 * Long text lives behind one of these instead of filling the screen on a phone.
 */
export interface DisclosureOptions {
  /** Bold line on the closed row. */
  title: string;
  /** One muted line next to the title, closed and open (optional). */
  summary?: string;
  /** Extra nodes inside the summary row, such as the pipeline chip strip. */
  summaryExtra?: HTMLElement | null;
  open?: boolean;
  testId?: string;
  /** Extra class on the `<details>` element. */
  className?: string;
  onToggle?: (open: boolean) => void;
}

export function disclosure(opts: DisclosureOptions, ...children: Array<Node | string | null>): HTMLDetailsElement {
  const head = el('div', { class: 'fold-head' }, el('span', { class: 'fold-title' }, opts.title), opts.summary ? el('span', { class: 'fold-sub small muted' }, opts.summary) : null);
  const details = el(
    'details',
    { class: `fold ${opts.className ?? ''}`.trim(), 'data-testid': opts.testId, open: opts.open ?? false },
    el('summary', null, head, opts.summaryExtra ?? null),
    el('div', { class: 'stack fold-body' }, ...children),
  );
  if (opts.onToggle) details.addEventListener('toggle', () => opts.onToggle?.(details.open));
  return details;
}
