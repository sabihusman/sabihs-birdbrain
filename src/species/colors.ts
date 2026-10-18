/**
 * Deterministic species colours. Each species gets a fixed hue derived from a
 * hash of its scientific name, rendered in OKLCH at a lightness that stays
 * readable on both light and dark backgrounds. Colour is always paired with
 * the species name in the UI; it is never the only cue.
 */

export interface SpeciesColor {
  hue: number;
  rgb: [number, number, number];
  /** rgb(r, g, b) */
  css: string;
}

/** FNV-1a 32-bit hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function srgbGamma(c: number): number {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** OKLCH -> sRGB (0-255), clamped. */
export function oklchToRgb(L: number, C: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [Math.round(srgbGamma(r) * 255), Math.round(srgbGamma(g) * 255), Math.round(srgbGamma(bb) * 255)];
}

const LIGHTNESS = 0.64;
const CHROMA = 0.15;
const cache = new Map<string, SpeciesColor>();

/** Fixed colour for a species, keyed by scientific name. Stable across sessions and devices. */
export function speciesColor(scientific: string): SpeciesColor {
  const cached = cache.get(scientific);
  if (cached) return cached;
  const hash = hashString(scientific);
  // Spread hashes around the wheel with the golden angle so neighbouring hashes differ in hue.
  const hue = (hash * 137.50776405003785) % 360;
  const rgb = oklchToRgb(LIGHTNESS, CHROMA, hue);
  const color: SpeciesColor = { hue, rgb, css: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` };
  cache.set(scientific, color);
  return color;
}

export function withAlpha(color: SpeciesColor, alpha: number): string {
  const [r, g, b] = color.rgb;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
