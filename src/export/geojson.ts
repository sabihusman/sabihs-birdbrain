import type { DetectionRecord } from '../storage/types';

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

/** Detections with a position become Point features ([lon, lat] per RFC 7946). */
export function detectionsToGeoJson(detections: DetectionRecord[]): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];
  for (const d of detections) {
    if (d.lat == null || d.lon == null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      properties: {
        id: d.id,
        time: new Date(d.time).toISOString(),
        scientific_name: d.scientific,
        common_name: d.common,
        confidence: Number(d.confidence.toFixed(4)),
        accuracy_m: d.accuracy,
        recording_id: d.recordingId,
        offset_sec: d.offsetSec,
        source: d.source,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
