import { el } from '../dom';

/** How long the flash stays, in milliseconds (one pulse: well under the 3-flashes-a-second limit). */
export const FLASH_MS = 1000;

/** "rgb(12, 34, 56)" or "#0c2238" → "rgba(12, 34, 56, a)"; anything else gives a soft grey, never a solid fill. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (hex) return `rgba(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)}, ${alpha})`;
  return `rgba(128, 128, 128, ${alpha})`;
}

/**
 * The "a bird is found" flash (DECISIONS.md #134, #137): the whole screen tints in the bird's own colour with a thick
 * glowing edge, once. It is on <body> so it covers the screen in every layout, flipped or not, and never takes a tap.
 *
 * Built for iPhones too (#137: the first version, a thin edge animated by CSS custom properties and `color-mix()`, did
 * not show on Sabih's iPhone): every colour is computed here and set as a plain style, and the pulse is a Web
 * Animations call, not a stylesheet animation. With reduced motion it shows without the pulse and goes.
 * Returns a function that removes it at once.
 */
export function flashForBird(color: string, ms = FLASH_MS): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.querySelectorAll('.bird-flash').forEach((n) => n.remove());
  const flash = el('div', { class: 'bird-flash', 'aria-hidden': 'true', 'data-testid': 'bird-flash' });
  flash.style.backgroundColor = withAlpha(color, 0.16);
  flash.style.boxShadow = `inset 0 0 0 10px ${color}, inset 0 0 72px 28px ${withAlpha(color, 0.55)}`;
  flash.dataset.color = color;
  document.body.appendChild(flash);
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!calm && typeof flash.animate === 'function') {
    flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
  }
  const timer = setTimeout(() => flash.remove(), ms);
  return () => {
    clearTimeout(timer);
    flash.remove();
  };
}
