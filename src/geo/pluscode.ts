import { OpenLocationCode } from 'open-location-code';

const olc = new OpenLocationCode();

/** Full 10-character Plus Code (Open Location Code), ~14 m x 14 m cell. */
export function plusCode(lat: number, lon: number): string {
  return olc.encode(lat, lon);
}

export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** Google Maps search link for a coordinate (opens the Maps app on phones). */
export function googleMapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat.toFixed(6)},${lon.toFixed(6)}`)}`;
}
