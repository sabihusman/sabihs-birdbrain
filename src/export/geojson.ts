import type { SightingRecord } from '../storage/types';

export interface GeoJsonFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

/** Sightings with a position become Point features ([lon, lat] per RFC 7946). */
export function sightingsToGeoJson(sightings: SightingRecord[]): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];
  for (const s of sightings) {
    if (s.lat == null || s.lon == null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        id: s.id,
        first_time: new Date(s.firstTime).toISOString(),
        last_time: new Date(s.lastTime).toISOString(),
        scientific_name: s.scientific,
        common_name: s.common,
        peak_confidence: Number(s.peakConfidence.toFixed(4)),
        hits: s.hits,
        accuracy_m: s.accuracy,
        recording_id: s.recordingId,
        offset_sec: s.offsetSec,
        source: s.source,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
