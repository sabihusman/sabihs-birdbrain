import { describe, expect, it } from 'vitest';
import { compactWhen, compactWhere, detailsHref, newestSighting, PIN_NEWEST_PX, PIN_PX, pinLabel, pinSize } from '../src/ui/map-pins';

const now = new Date(2026, 9, 23, 12).getTime();
const at = new Date(2026, 9, 21, 18, 42).getTime();
const base = { id: 'a', scientific: 'Bubo virginianus', common: 'Great Horned Owl', firstTime: at, lastTime: at, peakConfidence: 0.834, lat: 41.740132, lon: -93.718449, accuracy: 5, fixTime: at, recordingId: null as string | null };

describe('compact card lines', () => {
  it('writes date, time and confidence on one line', () => {
    const date = new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(compactWhen(base, now)).toBe(`${date} · ${time} · 83%`);
    expect(compactWhen({ ...base, firstTime: new Date(2025, 4, 1, 7).getTime() }, now)).toMatch(/2025 · .* · 83%$/);
  });

  it('writes the coordinates with a real minus sign and the accuracy', () => {
    expect(compactWhere(base)).toBe('41.74013, −93.71845 · ±5 m');
    // The same words as the sighting card's location block (describeAccuracy).
    expect(compactWhere({ ...base, accuracy: null })).toBe('41.74013, −93.71845 · approximate');
    expect(compactWhere({ ...base, accuracy: 1500 })).toBe('41.74013, −93.71845 · approximate (±1.5 km)');
    // A fix taken long before the detection is only approximate, as on the sighting card.
    expect(compactWhere({ ...base, fixTime: at - 10 * 60_000 })).toBe('41.74013, −93.71845 · approximate (±5 m)');
  });

  it('names the pin for screen readers', () => {
    const date = new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(pinLabel(base, now)).toBe(`Great Horned Owl, ${date}. Show details`);
  });
});

describe('pins', () => {
  it('finds the newest sighting and makes only its pin larger', () => {
    const list = [
      { ...base, id: 'old', lastTime: at - 86_400_000 },
      { ...base, id: 'new', lastTime: at },
      { ...base, id: 'mid', lastTime: at - 3_600_000 },
    ];
    const newest = newestSighting(list);
    expect(newest?.id).toBe('new');
    expect(list.map((s) => pinSize(s, newest!.id))).toEqual([PIN_PX, PIN_NEWEST_PX, PIN_PX]);
    expect(PIN_NEWEST_PX).toBe(52);
    expect(PIN_PX).toBe(40);
    expect(newestSighting([])).toBeNull();
    // A tie keeps the first (newest-first order from the bird summary).
    expect(newestSighting([{ ...base, id: 'x' }, { ...base, id: 'y' }])?.id).toBe('x');
  });
});

describe('Details link', () => {
  it('opens the sighting card in Recordings when there is a recording', () => {
    expect(detailsHref({ ...base, recordingId: 'rec 1' })).toBe('#/recordings/rec%201');
  });

  it('falls back to the species page without one', () => {
    expect(detailsHref(base)).toBe('#/species/Bubo%20virginianus');
  });
});
