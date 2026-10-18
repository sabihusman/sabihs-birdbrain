import type { DetectionRecord } from '../storage/types';

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const DETECTION_CSV_COLUMNS = [
  'id',
  'time_iso',
  'scientific_name',
  'common_name',
  'confidence',
  'latitude',
  'longitude',
  'accuracy_m',
  'recording_id',
  'offset_sec',
  'source',
] as const;

export function detectionsToCsv(detections: DetectionRecord[]): string {
  const lines = [DETECTION_CSV_COLUMNS.join(',')];
  for (const d of detections) {
    lines.push(
      [
        d.id,
        new Date(d.time).toISOString(),
        d.scientific,
        d.common,
        d.confidence.toFixed(4),
        d.lat,
        d.lon,
        d.accuracy == null ? '' : Math.round(d.accuracy),
        d.recordingId,
        d.offsetSec,
        d.source,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
