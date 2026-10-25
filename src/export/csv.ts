import { SOUND_ONLY_TAG } from '../species/sound-only';
import type { SightingRecord } from '../storage/types';

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per sighting (merged consecutive detections), not per analysis window. */
export const SIGHTING_CSV_COLUMNS = [
  'id',
  'first_time_iso',
  'last_time_iso',
  'scientific_name',
  'common_name',
  'peak_confidence',
  'hits',
  'latitude',
  'longitude',
  'accuracy_m',
  'recording_id',
  'offset_sec',
  'source',
  // "sound only": kept although the location filter did not expect the bird there (DECISIONS.md #93).
  'location_check',
] as const;

export function sightingsToCsv(sightings: SightingRecord[]): string {
  const lines = [SIGHTING_CSV_COLUMNS.join(',')];
  for (const s of sightings) {
    lines.push(
      [
        s.id,
        new Date(s.firstTime).toISOString(),
        new Date(s.lastTime).toISOString(),
        s.scientific,
        s.common,
        s.peakConfidence.toFixed(4),
        s.hits,
        s.lat,
        s.lon,
        s.accuracy == null ? '' : Math.round(s.accuracy),
        s.recordingId,
        s.offsetSec,
        s.source,
        s.soundOnly ? SOUND_ONLY_TAG : '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
