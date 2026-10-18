import { describe, expect, it } from 'vitest';
import { isValidLatLon, weekOfYear48 } from '../src/model/geo';

describe('weekOfYear48', () => {
  it('uses four slots per month', () => {
    expect(weekOfYear48(new Date(2026, 0, 1))).toBe(1);
    expect(weekOfYear48(new Date(2026, 0, 7))).toBe(1);
    expect(weekOfYear48(new Date(2026, 0, 8))).toBe(2);
    expect(weekOfYear48(new Date(2026, 0, 15))).toBe(2);
    expect(weekOfYear48(new Date(2026, 0, 16))).toBe(3);
    expect(weekOfYear48(new Date(2026, 0, 23))).toBe(3);
    expect(weekOfYear48(new Date(2026, 0, 24))).toBe(4);
    expect(weekOfYear48(new Date(2026, 0, 31))).toBe(4);
  });

  it('spans 1..48 across the year', () => {
    expect(weekOfYear48(new Date(2026, 1, 1))).toBe(5);
    expect(weekOfYear48(new Date(2026, 5, 15))).toBe(22);
    expect(weekOfYear48(new Date(2026, 11, 31))).toBe(48);
    expect(weekOfYear48(new Date(2024, 1, 29))).toBe(8);
  });
});

describe('isValidLatLon', () => {
  it('accepts valid and rejects invalid coordinates', () => {
    expect(isValidLatLon(42.4, -76.5)).toBe(true);
    expect(isValidLatLon(91, 0)).toBe(false);
    expect(isValidLatLon(0, 181)).toBe(false);
    expect(isValidLatLon(NaN, 0)).toBe(false);
  });
});
