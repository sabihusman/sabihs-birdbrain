/**
 * BirdNET's "week" is not an ISO week: the year is split into 48 slots, four
 * per month. Slot 1 covers roughly days 1-7, slot 4 roughly days 24-31.
 * -1 means "no seasonal filter" (year-round species list).
 */
export const NO_WEEK = -1;

export function weekOfYear48(date: Date): number {
  const month = date.getMonth(); // 0-11
  const day = date.getDate(); // 1-31
  const slot = Math.min(4, Math.max(1, Math.ceil(day / 7.75)));
  return month * 4 + slot;
}

export interface GeoLocation {
  lat: number;
  lon: number;
  /** Accuracy in metres, if known. */
  accuracy: number | null;
  source: 'gps' | 'manual';
}

export function isValidLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}
