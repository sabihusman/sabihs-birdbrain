/** Pure helpers for the Map tab's photo pins and compact card (DECISIONS.md #75). Unit-tested. */
import { describeAccuracy } from '../app/position-watch';
import { formatLatLon } from '../geo/pluscode';
import { hrefFor, speciesHref } from './router';
import { shortDate } from './map-summary';

export interface PinSighting {
  id: string;
  scientific: string;
  common: string;
  firstTime: number;
  lastTime: number;
  peakConfidence: number;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  fixTime?: number | null;
  recordingId: string | null;
}

/** Pin diameters in CSS px: the newest sighting of the chosen bird is a little larger. */
export const PIN_NEWEST_PX = 52;
export const PIN_PX = 40;

/** The most recently seen sighting (latest `lastTime`; the first one wins a tie), or null for none. */
export function newestSighting<S extends Pick<PinSighting, 'lastTime'>>(list: readonly S[]): S | null {
  let best: S | null = null;
  for (const s of list) if (!best || s.lastTime > best.lastTime) best = s;
  return best;
}

export function pinSize(s: Pick<PinSighting, 'id'>, newestId: string | null): number {
  return s.id === newestId ? PIN_NEWEST_PX : PIN_PX;
}

/** "6:42 PM" in the phone's locale. */
function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Oct 21 · 6:42 PM · 83%" (the year is added outside the current one). */
export function compactWhen(s: Pick<PinSighting, 'firstTime' | 'peakConfidence'>, now = Date.now()): string {
  return `${shortDate(s.firstTime, now)} · ${shortTime(s.firstTime)} · ${Math.round(s.peakConfidence * 100)}%`;
}

/** "41.74013, −93.71845 · ±5 m": the copied text keeps the plain hyphen, the shown one a real minus sign. */
export function compactWhere(s: Pick<PinSighting, 'lat' | 'lon' | 'accuracy' | 'fixTime' | 'firstTime'>): string {
  const coords = formatLatLon(s.lat ?? 0, s.lon ?? 0).replace(/-/g, '−');
  const reading = describeAccuracy({ accuracy: s.accuracy ?? null, fixTime: s.fixTime ?? null }, s.firstTime);
  return reading ? `${coords} · ${reading}` : coords;
}

/** "Black-capped Chickadee, Oct 21. Show details" (the pin's accessible name). */
export function pinLabel(s: Pick<PinSighting, 'common' | 'firstTime'>, now = Date.now()): string {
  return `${s.common}, ${shortDate(s.firstTime, now)}. Show details`;
}

/** Details ›: the sighting card in Recordings when the sighting has a saved recording, else the species page. */
export function detailsHref(s: Pick<PinSighting, 'recordingId' | 'scientific'>): string {
  return s.recordingId ? hrefFor({ name: 'recording', id: s.recordingId }) : speciesHref(s.scientific);
}
