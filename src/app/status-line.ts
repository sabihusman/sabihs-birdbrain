import type { Cell } from '../geo/areas';
import type { PlaceLabel } from '../geo/geocode';

/**
 * Listen's one status line before listening (DECISIONS.md #108), replacing the three pills (a plus code, "Week 41
 * birds", "Min. 70%"): plain words, nothing that looks tappable, the same in every layout.
 *   "Near Johnston · October birds · Only matches 70% or more"
 *   "No location · All year · Only matches 70% or more" + "Turn on location to filter for your area ›"
 */
export interface StatusLine {
  text: string;
  /** Shown as a link to Settings › Location when there is no location; null otherwise. */
  link: string | null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const NO_LOCATION_LINK = 'Turn on location to filter for your area ›';

export function statusLine(opts: { hasLocation: boolean; place: string | null; useWeek: boolean; threshold: number; now: Date }): StatusLine {
  const min = `Only matches ${Math.round(opts.threshold * 100)}% or more`;
  if (!opts.hasLocation) return { text: `No location · All year · ${min}`, link: NO_LOCATION_LINK };
  // The filter uses BirdNET's 48 weeks; the month is only the word for it.
  const season = opts.useWeek ? `${MONTHS[opts.now.getMonth()]} birds` : 'All-year birds';
  return { text: `${opts.place ? `Near ${opts.place}` : 'Your area'} · ${season} · ${min}`, link: null };
}

/**
 * The town for "Near …": from a reverse-geocoded label, the locality on its second line ("Johnston, Iowa" →
 * "Johnston"), else the name itself; from a place picked by name, its first part ("Ithaca, New York" → "Ithaca").
 */
export function nearName(label: PlaceLabel | null): string | null {
  if (!label) return null;
  return label.line2.split(',')[0]?.trim() || label.name || null;
}
export function pickedName(manualPlace: string | null): string | null {
  return manualPlace?.split(',')[0]?.trim() || null;
}

/**
 * The position sent to name the town, rounded to 2 decimals (about 1 km), so the answer is cached per square
 * kilometre and the request never carries a precise position.
 */
export function nearCell(lat: number, lon: number): Cell {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { key: `near:${r(lat).toFixed(2)},${r(lon).toFixed(2)}`, lat: r(lat), lon: r(lon) };
}
