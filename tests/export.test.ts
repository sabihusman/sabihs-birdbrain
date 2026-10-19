import { describe, expect, it } from 'vitest';
import { csvEscape, sightingsToCsv, SIGHTING_CSV_COLUMNS } from '../src/export/csv';
import { sightingsToGeoJson } from '../src/export/geojson';
import type { SightingRecord } from '../src/storage/types';

const sightings: SightingRecord[] = [
  {
    id: 'a',
    firstTime: Date.UTC(2026, 4, 1, 6, 30, 0),
    lastTime: Date.UTC(2026, 4, 1, 6, 30, 45),
    label: "Astur cooperii_Cooper's Hawk",
    scientific: 'Astur cooperii',
    common: "Cooper's Hawk",
    peakConfidence: 0.87654,
    hits: 4,
    lat: 42.44,
    lon: -76.5,
    accuracy: 12.4,
    recordingId: 'rec1',
    offsetSec: 3,
    source: 'live',
    sessionId: 's1',
    peakDetectionId: 'd1',
  },
  {
    id: 'b',
    firstTime: Date.UTC(2026, 4, 1, 6, 31, 0),
    lastTime: Date.UTC(2026, 4, 1, 6, 31, 0),
    label: 'Weird, "quoted"_Name, with comma',
    scientific: 'Weird, "quoted"',
    common: 'Name, with comma',
    peakConfidence: 0.5,
    hits: 1,
    lat: null,
    lon: null,
    accuracy: null,
    recordingId: null,
    offsetSec: null,
    source: 'import',
    sessionId: 's1',
    peakDetectionId: 'd2',
  },
];

describe('CSV export', () => {
  it('escapes commas and quotes', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(null)).toBe('');
  });

  it('writes a header and one row per sighting (not per analysis window)', () => {
    const csv = sightingsToCsv(sightings);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(SIGHTING_CSV_COLUMNS.join(','));
    expect(lines.length).toBe(3);
    expect(lines[1]).toBe("a,2026-05-01T06:30:00.000Z,2026-05-01T06:30:45.000Z,Astur cooperii,Cooper's Hawk,0.8765,4,42.44,-76.5,12,rec1,3,live");
    expect(lines[2]).toBe('b,2026-05-01T06:31:00.000Z,2026-05-01T06:31:00.000Z,"Weird, ""quoted""","Name, with comma",0.5000,1,,,,,,import');
  });
});

describe('GeoJSON export', () => {
  it('emits Point features as [lon, lat] and skips sightings without a position', () => {
    const fc = sightingsToGeoJson(sightings);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features.length).toBe(1);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [-76.5, 42.44] });
    expect(fc.features[0].properties).toMatchObject({ scientific_name: 'Astur cooperii', peak_confidence: 0.8765, hits: 4, recording_id: 'rec1' });
    expect(() => JSON.stringify(fc)).not.toThrow();
  });
});
