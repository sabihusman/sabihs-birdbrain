import { describe, expect, it } from 'vitest';
import { describeRegion, isNearbyQuestion, REGION_CODES, regionFor, roundCoordinate, shapeAskRequest } from '../src/geo/region';

describe('on-device region for Ask', () => {
  it('maps known places to their state/province code', () => {
    const cases: Array<[string, number, number, string]> = [
      ['Des Moines', 41.59, -93.62, 'US-IA'],
      ['Iowa City', 41.66, -91.53, 'US-IA'],
      ['Dubuque (west bank)', 42.5, -90.69, 'US-IA'],
      ['Burlington IA (west bank)', 40.81, -91.12, 'US-IA'],
      ['Fort Madison IA', 40.63, -91.35, 'US-IA'],
      ['Galena IL (in the overlap strip, east of the river)', 42.42, -90.43, 'US-IL'],
      ['Fulton IL (east bank)', 41.87, -90.16, 'US-IL'],
      ['Macomb IL (in the overlap strip)', 40.46, -90.67, 'US-IL'],
      ['Chicago', 41.88, -87.63, 'US-IL'],
      ['Springfield IL', 39.8, -89.65, 'US-IL'],
      ['Seattle', 47.61, -122.33, 'US-WA'],
      ['Spokane', 47.66, -117.43, 'US-WA'],
      ['Calgary', 51.05, -114.07, 'CA-AB'],
      ['Edmonton', 53.55, -113.49, 'CA-AB'],
      ['Toronto', 43.65, -79.38, 'CA-ON'],
      ['Ottawa', 45.42, -75.7, 'CA-ON'],
      ['Thunder Bay', 48.38, -89.25, 'CA-ON'],
      ['Kenora (north-west Ontario)', 49.77, -94.49, 'CA-ON'],
      ['Sudbury', 46.49, -80.99, 'CA-ON'],
    ];
    for (const [name, lat, lon, code] of cases) expect(regionFor(lat, lon), name).toBe(code);
  });

  it('is "none" outside every box, including neighbours the boxes were trimmed to exclude', () => {
    const outside: Array<[string, number, number]> = [
      ['Minneapolis', 44.98, -93.27],
      ['Grand Portage MN (below the Superior box)', 47.96, -89.68],
      ['Duluth', 46.79, -92.1],
      ['Milwaukee', 43.04, -87.91],
      ['Grand Rapids MI', 42.96, -85.67],
      ['Portland OR', 45.52, -122.68],
      ['Vancouver BC', 49.28, -123.12],
      ['Regina SK', 50.45, -104.62],
      ['Montreal', 45.5, -73.57],
      ['London', 51.5, -0.12],
      ['null island', 0, 0],
    ];
    for (const [name, lat, lon] of outside) expect(regionFor(lat, lon), name).toBe('none');
    expect(regionFor(Number.NaN, 0)).toBe('none');
    expect(regionFor(41.6, Number.POSITIVE_INFINITY)).toBe('none');
  });

  it('rounds to one decimal (about 10 km) and never sends more precision', () => {
    expect(roundCoordinate(41.6611)).toBe(41.7);
    expect(roundCoordinate(-91.5302)).toBe(-91.5);
    expect(roundCoordinate(41.65)).toBe(41.7);
    expect(roundCoordinate(0)).toBe(0);
    for (const x of [41.6611, -91.5302, 12.3456789, -0.04]) expect(Math.round(roundCoordinate(x) * 10) === roundCoordinate(x) * 10).toBe(true);
  });

  it('recognises nearby questions by their wording', () => {
    for (const q of ['Has it been seen near me?', 'Any sightings nearby?', 'Is it around here in winter?', 'Is it common in my area?', 'Are they local?', 'Seen in this county lately?', 'close by?', 'NEAR here?']) expect(isNearbyQuestion(q), q).toBe(true);
    for (const q of ['What does it eat?', 'How does it sing?', 'Is it nearly extinct?', 'Is it a close relative of the thrush?', 'Where does it nest?']) expect(isNearbyQuestion(q), q).toBe(false);
  });

  it('shapes the request: region always, the rounded point only for nearby questions with a position', () => {
    const here = { lat: 41.6611, lon: -91.5302 };
    expect(shapeAskRequest('Turdus migratorius', 'What does it eat?', here)).toEqual({ species: 'Turdus migratorius', question: 'What does it eat?', region: 'US-IA' });
    expect(shapeAskRequest('Turdus migratorius', 'Seen near me?', here)).toEqual({ species: 'Turdus migratorius', question: 'Seen near me?', region: 'US-IA', near: { lat: 41.7, lon: -91.5 } });
    expect(shapeAskRequest('Turdus migratorius', 'Seen near me?', null)).toEqual({ species: 'Turdus migratorius', question: 'Seen near me?', region: 'none' });
    expect(shapeAskRequest('Turdus migratorius', 'Seen near me?', { lat: 51.5, lon: -0.12 })).toEqual({ species: 'Turdus migratorius', question: 'Seen near me?', region: 'none', near: { lat: 51.5, lon: -0.1 } });
    const json = JSON.stringify(shapeAskRequest('X y', 'near me', here));
    expect(json).not.toContain('41.6611');
    expect(json).not.toContain('91.5302');
    expect(REGION_CODES).toEqual(['US-IA', 'US-IL', 'US-WA', 'CA-AB', 'CA-ON']);
    expect(describeRegion('US-IA')).toBe('Iowa (US-IA)');
    expect(describeRegion('none')).toContain('outside Iowa');
  });
});
