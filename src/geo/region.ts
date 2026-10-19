/**
 * On-device region for "Ask about this bird": the state/province code that
 * goes to the server instead of a position. Five regions, each a simple
 * latitude/longitude bounding box (WGS84, degrees); a point outside every box
 * is "none". Boxes are tested in the order below and the first match wins.
 *
 * Boxes (south, north, west, east), from the states' extreme points:
 *   US-IA  40.37 … 43.50,  −96.64 … −90.14
 *   US-IL  36.97 … 42.51,  −91.51 … −87.49
 *   US-WA  45.54 … 49.00, −124.85 … −116.92
 *   CA-AB  49.00 … 60.00, −120.00 … −110.00
 *   CA-ON  three boxes: north 49.00 … 56.86, −95.16 … −79.00; south
 *          41.68 … 49.00, −84.80 … −74.32; and the Lake Superior north shore
 *          48.30 … 49.00, −91.00 … −84.80 (Thunder Bay), so that Minnesota,
 *          Wisconsin and most of Michigan are not read as Ontario
 * Known limits: the Iowa/Illinois overlap along the Mississippi is split by a
 * five-point polyline following the river (Dubuque, Clinton, Muscatine,
 * Burlington, Keokuk), so towns right on the bank, and the Quad Cities where
 * the river runs east–west, can land on either side; the
 * Illinois box is tried before Ontario's, so Chicago is Illinois; the
 * Michigan "thumb" east of −84.80 (Detroit, Port Huron) falls in Ontario's
 * southern box, and the boxes include some water and slivers of neighbours.
 * The note under the Ask box shows the code before anything is sent.
 */
export const REGION_CODES = ['US-IA', 'US-IL', 'US-WA', 'CA-AB', 'CA-ON'] as const;
export type RegionCode = (typeof REGION_CODES)[number];
export type Region = RegionCode | 'none';

export const REGION_NAMES: Record<RegionCode, string> = {
  'US-IA': 'Iowa',
  'US-IL': 'Illinois',
  'US-WA': 'Washington',
  'CA-AB': 'Alberta',
  'CA-ON': 'Ontario',
};

interface Box {
  south: number;
  north: number;
  west: number;
  east: number;
}

const BOXES: Array<{ code: RegionCode; box: Box }> = [
  { code: 'US-IA', box: { south: 40.37, north: 43.5, west: -96.64, east: -90.14 } },
  { code: 'US-IL', box: { south: 36.97, north: 42.51, west: -91.51, east: -87.49 } },
  { code: 'US-WA', box: { south: 45.54, north: 49.0, west: -124.85, east: -116.92 } },
  { code: 'CA-AB', box: { south: 49.0, north: 60.0, west: -120.0, east: -110.0 } },
  { code: 'CA-ON', box: { south: 49.0, north: 56.86, west: -95.16, east: -79.0 } },
  { code: 'CA-ON', box: { south: 41.68, north: 49.0, west: -84.8, east: -74.32 } },
  { code: 'CA-ON', box: { south: 48.3, north: 49.0, west: -91.0, east: -84.8 } },
];

const inBox = (lat: number, lon: number, b: Box) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

/**
 * The Mississippi between Dubuque and Keokuk as a polyline (lat, lon), north
 * to south; used only inside the Iowa/Illinois overlap. Returns the river's
 * longitude at this latitude (clamped at the ends).
 */
const MISSISSIPPI: Array<[number, number]> = [
  [42.5, -90.65], // Dubuque
  [41.84, -90.18], // Clinton
  [41.42, -91.03], // Muscatine
  [40.8, -91.09], // Burlington
  [40.39, -91.4], // Keokuk
];
function mississippiLon(lat: number): number {
  if (lat >= MISSISSIPPI[0][0]) return MISSISSIPPI[0][1];
  for (let i = 1; i < MISSISSIPPI.length; i++) {
    const [lat0, lon0] = MISSISSIPPI[i - 1];
    const [lat1, lon1] = MISSISSIPPI[i];
    if (lat >= lat1) return lon0 + ((lat0 - lat) / (lat0 - lat1)) * (lon1 - lon0);
  }
  return MISSISSIPPI[MISSISSIPPI.length - 1][1];
}

export function regionFor(lat: number, lon: number): Region {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'none';
  for (const { code, box } of BOXES) {
    if (!inBox(lat, lon, box)) continue;
    if (code === 'US-IA' && inBox(lat, lon, BOXES[1].box) && lon > mississippiLon(lat)) continue; // east of the river: Illinois
    return code;
  }
  return 'none';
}

/** One decimal, about 10 km: what the app sends for nearby questions. */
export function roundCoordinate(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Words that make a question about sightings around the asker. */
const NEARBY = /\b(near(by| me| here| us)?|around here|close (by|to (me|here|us))|in my area|my area|local(ly)?|this county|my county|my (state|province)|around me)\b/i;

export function isNearbyQuestion(question: string): boolean {
  return NEARBY.test(question);
}

export interface AskRequest {
  species: string;
  question: string;
  region: Region;
  near?: { lat: number; lon: number };
}

/**
 * Exactly what the Ask box sends: species, question, the region code (or
 * "none") and, only for a nearby question with a known position, the position
 * rounded to one decimal. Never the raw position.
 */
export function shapeAskRequest(species: string, question: string, location: { lat: number; lon: number } | null): AskRequest {
  const region = location ? regionFor(location.lat, location.lon) : 'none';
  const req: AskRequest = { species, question, region };
  if (location && isNearbyQuestion(question)) req.near = { lat: roundCoordinate(location.lat), lon: roundCoordinate(location.lon) };
  return req;
}

/** "Iowa (US-IA)" or "none (outside Iowa, Illinois, Washington, Alberta and Ontario)" for the note under the box. */
export function describeRegion(region: Region): string {
  return region === 'none' ? 'none (outside Iowa, Illinois, Washington, Alberta and Ontario)' : `${REGION_NAMES[region]} (${region})`;
}
