import { el } from '../dom';

/** How long the edge glow stays, in milliseconds (one pulse: well under the 3-flashes-a-second limit). */
export const FLASH_MS = 700;

/**
 * The "a bird is found" flash (DECISIONS.md #134): a glow around the edge of the screen in the bird's own colour, once.
 * It is on <body> so it covers the whole screen in every layout, flipped or not, and never takes a tap. With reduced
 * motion it shows without the pulse and goes. Returns a function that removes it at once.
 */
export function flashForBird(color: string, ms = FLASH_MS): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.querySelectorAll('.bird-flash').forEach((n) => n.remove());
  const flash = el('div', { class: 'bird-flash', 'aria-hidden': 'true', 'data-testid': 'bird-flash' });
  flash.style.setProperty('--flash-color', color);
  flash.style.setProperty('--flash-ms', `${ms}ms`);
  document.body.appendChild(flash);
  const timer = setTimeout(() => flash.remove(), ms);
  return () => {
    clearTimeout(timer);
    flash.remove();
  };
}
