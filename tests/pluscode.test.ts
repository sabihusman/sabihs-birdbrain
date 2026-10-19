import { describe, expect, it } from 'vitest';
import { formatLatLon, googleMapsUrl, plusCode } from '../src/geo/pluscode';

describe('Plus Codes and map links', () => {
  it('encodes a known location (Google Zürich office example from the OLC docs)', () => {
    expect(plusCode(47.36559, 8.524997)).toBe('8FVC9G8F+6X');
  });
  it('produces a full 10-character code anywhere', () => {
    expect(plusCode(42.44, -76.5)).toMatch(/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2}$/);
    expect(plusCode(-33.8688, 151.2093)).toMatch(/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2}$/);
  });
  it('formats coordinates and builds the Google Maps search URL', () => {
    expect(formatLatLon(42.4401234, -76.5)).toBe('42.44012, -76.50000');
    expect(googleMapsUrl(42.44, -76.5)).toBe('https://www.google.com/maps/search/?api=1&query=42.440000%2C-76.500000');
  });
});
