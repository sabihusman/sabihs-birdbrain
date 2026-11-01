import { describe, expect, it } from 'vitest';
import { nearCell, nearName, NO_LOCATION_LINK, pickedName, statusLine } from '../src/app/status-line';

const oct = new Date(2026, 9, 31);

describe('Listen status line (DECISIONS.md #108)', () => {
  it('says where, which season and the minimum in words, no codes', () => {
    expect(statusLine({ hasLocation: true, place: 'Johnston', useWeek: true, threshold: 0.7, now: oct })).toEqual({ text: 'Near Johnston · October birds · Only matches 70% or more', link: null });
    expect(statusLine({ hasLocation: true, place: null, useWeek: false, threshold: 0.55, now: oct }).text).toBe('Your area · All-year birds · Only matches 55% or more');
    expect(statusLine({ hasLocation: false, place: 'Johnston', useWeek: true, threshold: 0.7, now: oct })).toEqual({ text: 'No location · All year · Only matches 70% or more', link: NO_LOCATION_LINK });
  });

  it('names the town from a reverse-geocoded label or a picked place', () => {
    expect(nearName({ name: 'Merle Hay Road', line2: 'Johnston, Iowa' })).toBe('Johnston');
    expect(nearName({ name: 'Ithaca', line2: '' })).toBe('Ithaca');
    expect(nearName(null)).toBeNull();
    expect(pickedName('Ithaca, New York')).toBe('Ithaca');
    expect(pickedName(null)).toBeNull();
  });

  it('sends a position rounded to about 1 km, and caches per square', () => {
    expect(nearCell(41.67349, -93.69812)).toEqual({ key: 'near:41.67,-93.70', lat: 41.67, lon: -93.7 });
    expect(nearCell(41.6749, -93.6951).key).toBe(nearCell(41.6701, -93.7049).key);
  });
});
