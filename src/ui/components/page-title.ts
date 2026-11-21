import { el } from '../dom';

/**
 * The heading at the top of a main page (Recordings, Species, Map, Settings; DECISIONS.md #131), so the lit tab is
 * not the only sign of where you are. Listen has none: its state title ("Ready", "Model not loaded") is the heading.
 */
export function pageTitle(text: string): HTMLElement {
  return el('h1', { class: 'page-title', 'data-testid': 'page-title' }, text);
}
