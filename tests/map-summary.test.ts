import { describe, expect, it } from 'vitest';
import { birdCardLine, birdsCountLine, placeCardLine, summarizeBirds } from '../src/ui/map-summary';

const day = 86_400_000;
const now = new Date(2026, 9, 23, 12).getTime();
const s = (scientific: string, common: string, lastTime: number, lat: number | null = 41.7) => ({ scientific, common, lat, lon: lat == null ? null : -93.7, firstTime: lastTime, lastTime });

describe('bird cards', () => {
  it('one entry per located species, the most recently seen first, sightings newest first', () => {
    const out = summarizeBirds([s('A a', 'Alpha', now - 3 * day), s('B b', 'Beta', now - day), s('A a', 'Alpha', now - 5 * day), s('C c', 'Gamma', now, null)]);
    expect(out.map((b) => b.common)).toEqual(['Beta', 'Alpha']);
    expect(out[1].sightings.map((x) => x.lastTime)).toEqual([now - 3 * day, now - 5 * day]);
    expect(out[1].last).toBe(now - 3 * day);
  });

  it('writes the card and count lines in plain words', () => {
    const oct20 = new Date(2026, 9, 20, 12).getTime();
    const label = oct20 && new Date(oct20).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(birdCardLine(1, oct20, now)).toBe(`1 sighting · ${label}`);
    expect(birdCardLine(6, oct20, now)).toBe(`6 sightings · last ${label}`);
    expect(birdCardLine(2, new Date(2025, 4, 1).getTime(), now)).toMatch(/2025/);
    expect(placeCardLine(14, 7)).toBe('14 sightings · 7 species');
    expect(placeCardLine(1, 1)).toBe('1 sighting · 1 species');
    expect(birdsCountLine(13, 23)).toBe('13 species · 23 sightings with a location');
  });
});
