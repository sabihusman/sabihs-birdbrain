import { el } from './dom';

/**
 * ⇅ Flip (DECISIONS.md #126, Sabih's option A): pointing the bottom of a phone (and its microphone) at a bird turns
 * it upside down for the person holding it, so the app can turn its whole picture 180°. Web pages cannot lock or
 * set the screen orientation on iPhone, so the app turns itself: `html[data-flipped="true"]` rotates `.app` and swaps
 * the safe-area insets (styles.css). Only the picture turns; listening and identifying are unchanged. It turns back
 * when listening stops (src/ui/app.ts) and never applies from 1024 px wide, where Flip is hidden.
 */

type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

export function isFlipped(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.flipped === 'true';
}

export function setFlipped(on: boolean): void {
  if (on === isFlipped()) return;
  if (on) document.documentElement.dataset.flipped = 'true';
  else delete document.documentElement.dataset.flipped;
  for (const fn of [...listeners]) fn(on);
}

export function onFlip(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The words on a Flip button and for screen readers, for both states. */
export function flipLabels(on: boolean): { text: string; aria: string } {
  return on ? { text: '⇅ Flipped', aria: 'Turn the screen back' } : { text: '⇅ Flip', aria: 'Turn the screen upside down, for pointing the phone at a bird' };
}

/** A panel or dock button that flips; it keeps its words and pressed state in step wherever it is. */
export function flipButton(testId: string, onTurnOn?: () => void): { el: HTMLButtonElement; dispose: () => void } {
  const btn = el('button', { class: 'btn small flip-btn', type: 'button', 'data-testid': testId }) as HTMLButtonElement;
  const render = (on: boolean) => {
    const l = flipLabels(on);
    btn.textContent = l.text;
    btn.setAttribute('aria-label', l.aria);
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
  };
  render(isFlipped());
  btn.addEventListener('click', () => {
    const next = !isFlipped();
    setFlipped(next);
    if (next) onTurnOn?.();
  });
  return { el: btn, dispose: onFlip(render) };
}

export const FLIP_HINT_TEXT = 'Pointing the bottom at a bird? Tap ⇅ Flip to turn the screen.';
export const FLIP_HINT_MS = 3000;

export interface HintPlacement {
  side: 'above' | 'below';
  /** Distance of the bubble's right edge from the right of the window, lined up with the button's. */
  right: number;
  /** `top` when below the button, `bottom` when above the panel. */
  offset: number;
  /** Where the tip sits, from the bubble's right edge, so it points at the button's middle. */
  tipRight: number;
}

/**
 * Where the bubble goes (approved mockup, Nov 15): a button low on the screen (Focus's pinned panel, the dock) gets the
 * bubble above its panel with the tip pointing down; a button in the top half (Consolidated, BirdAmp) gets it just
 * under the button, pointing up. Never over the timer or the level.
 */
export function placeHint(button: Pick<DOMRect, 'top' | 'bottom' | 'right' | 'width'>, panelTop: number, viewport: { width: number; height: number }): HintPlacement {
  const below = button.bottom < viewport.height / 2;
  return {
    side: below ? 'below' : 'above',
    right: Math.max(8, Math.round(viewport.width - button.right)),
    offset: below ? Math.round(button.bottom + 14) : Math.round(viewport.height - Math.min(panelTop, button.top) + 12),
    tipRight: Math.max(10, Math.round(button.width / 2) - 7),
  };
}

/**
 * Show the bubble pointing at `button` for 3 seconds. Gone early on any tap or scroll, or when the screen flips.
 * Returns a function that removes it at once. Does nothing while already flipped or when the button is not shown.
 */
export function showFlipHint(button: HTMLElement, panel: HTMLElement | null, ms = FLIP_HINT_MS): () => void {
  if (isFlipped() || !button.isConnected || button.offsetParent === null) return () => undefined;
  const rect = button.getBoundingClientRect();
  if (rect.width === 0) return () => undefined;
  const place = placeHint(rect, panel?.getBoundingClientRect().top ?? rect.top, { width: window.innerWidth, height: window.innerHeight });
  const tip = el('span', { class: 'flip-hint-tip', 'aria-hidden': 'true' });
  const bubble = el('div', { class: `flip-hint ${place.side}`, role: 'status', 'data-testid': 'flip-hint' }, tip, el('span', null, 'Pointing the bottom at a bird? Tap ', el('b', null, '⇅ Flip'), ' to turn the screen.'));
  bubble.style.right = `${place.right}px`;
  if (place.side === 'below') bubble.style.top = `${place.offset}px`;
  else bubble.style.bottom = `${place.offset}px`;
  tip.style.right = `${place.tipRight}px`;
  let done = false;
  const scroller = document.querySelector('.app-scroll');
  const remove = () => {
    if (done) return;
    done = true;
    clearTimeout(fadeTimer);
    clearTimeout(goneTimer);
    document.removeEventListener('pointerdown', remove, true);
    scroller?.removeEventListener('scroll', remove);
    offFlip();
    bubble.remove();
  };
  // Fades over the last 300 ms (no fade with reduced motion, styles.css), then leaves.
  const fadeTimer = setTimeout(() => bubble.classList.add('leaving'), Math.max(0, ms - 300));
  const goneTimer = setTimeout(remove, ms);
  const offFlip = onFlip(remove);
  document.addEventListener('pointerdown', remove, true);
  scroller?.addEventListener('scroll', remove, { passive: true });
  document.body.appendChild(bubble);
  return remove;
}
