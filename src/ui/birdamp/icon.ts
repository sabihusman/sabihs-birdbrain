/**
 * BirdAmp's picker icon (DECISIONS.md #110): the supplied gold bolt on a white tile, from the SVG master in the
 * design doc. White in both themes on purpose (it carries its own background, like an app icon). Inline SVG with
 * presentation attributes only, so the CSP needs nothing extra. `id` keeps gradient ids unique on one page.
 */
let n = 0;
export function birdAmpBolt(size: number): string {
  const id = `ba-gold-${++n}`;
  return (
    `<svg class="ba-bolt" viewBox="0 0 96 96" width="${size}" height="${size}" focusable="false" aria-hidden="true">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#ffe873"/><stop offset="0.5" stop-color="#ffb400"/><stop offset="1" stop-color="#e08a00"/></linearGradient></defs>` +
    '<rect x="4" y="4" width="88" height="88" rx="18" fill="#ffffff" stroke="#d9d2bf" stroke-width="2"/>' +
    `<path d="M58 10 L26 53 L45 53 L36 86 L72 37 L51 37 Z" fill="url(#${id})" stroke="#8a5a00" stroke-width="2.5" stroke-linejoin="round"/>` +
    '<path d="M58 10 L26 53 L45 53 L40 70 L66 37 L51 37 Z" fill="#ffffff" opacity="0.28"/></svg>'
  );
}
