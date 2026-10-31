import { describe, expect, it } from 'vitest';
import { groupRecent } from '../src/species/recent';
import { applyDetection, sightingFromDetection } from '../src/species/sightings';
import { notUsualToggleText, SOUND_ONLY_NOTE } from '../src/species/sound-only';
import { compactWhen } from '../src/ui/map-pins';
import type { DetectionRecord } from '../src/storage/types';

const det = (over: Partial<DetectionRecord> = {}): DetectionRecord => ({
  id: 'd1',
  time: Date.UTC(2026, 9, 25, 9, 0),
  label: 'Strix varia_Barred Owl',
  scientific: 'Strix varia',
  common: 'Barred Owl',
  confidence: 0.82,
  lat: 51.5,
  lon: -0.12,
  accuracy: 8,
  fixTime: null,
  recordingId: null,
  offsetSec: null,
  source: 'live',
  sessionId: 's1',
  ...over,
});

describe('birds kept against the location filter (DECISIONS.md #93)', () => {
  it('words the line, the note and the toggle plainly', () => {
    expect(notUsualToggleText(1, false)).toBe('1 bird not usual here · show');
    expect(notUsualToggleText(3, false)).toBe('3 birds not usual here · show');
    expect(notUsualToggleText(3, true)).toBe('Hide birds not usual here');
    expect(SOUND_ONLY_NOTE).toBe('Verified by sound only, not location: this bird isn’t usually here.');
  });

  it('a kept window makes its sighting sound-only, and a later ordinary window does not undo it', () => {
    const s = sightingFromDetection(det({ soundOnly: true }));
    expect(s.soundOnly).toBe(true);
    applyDetection(s, det({ id: 'd2', time: s.lastTime + 5000, confidence: 0.9 }));
    expect(s.soundOnly).toBe(true);
    expect(sightingFromDetection(det()).soundOnly).toBeUndefined();
  });

  it('marks the Listen card and the map card', () => {
    const owl = { name: 'owl' };
    const groups = groupRecent([
      { key: 'Strix varia', species: owl, time: 1000, confidence: 0.8, soundOnly: true },
      { key: 'Turdus merula', species: owl, time: 2000, confidence: 0.7 },
    ]);
    expect(groups.find((g) => g.key === 'Strix varia')?.soundOnly).toBe(true);
    expect(groups.find((g) => g.key === 'Turdus merula')?.soundOnly).toBe(false);
    expect(compactWhen({ firstTime: Date.UTC(2026, 9, 25, 9, 0), peakConfidence: 0.83, soundOnly: true }, Date.UTC(2026, 9, 25, 12))).toMatch(/ · 83% · sound only$/);
  });
});

describe('the location banner while listening (DECISIONS.md #103)', () => {
  it('says what the filter does, how many it held back, and when it is doing nothing', async () => {
    const { locationBanner } = await import('../src/species/sound-only');
    expect(locationBanner(true, 'ok', 0, false)).toEqual({ kind: 'filter', text: 'Birds not usual here are held back', count: null });
    expect(locationBanner(true, 'ok', 2, false)).toEqual({ kind: 'held', text: 'Not usual here:', count: '2 · show' });
    expect(locationBanner(true, 'ok', 1, true).count).toBe('1 · hide');
    expect(locationBanner(false, 'locating', 3, false)).toEqual({ kind: 'locating', text: 'Finding your location…', count: null });
    for (const status of ['off', 'denied', 'unavailable', 'manual-missing']) expect(locationBanner(false, status, 0, false)).toEqual({ kind: 'none', text: 'No location: every species can show', count: null });
  });

  it('every version fits one short line', async () => {
    const { locationBanner } = await import('../src/species/sound-only');
    for (const b of [locationBanner(true, 'ok', 0, false), locationBanner(true, 'ok', 99, false), locationBanner(false, 'idle', 0, false), locationBanner(false, 'off', 0, false)]) {
      expect(`${b.text} ${b.count ?? ''}`.trim().length).toBeLessThanOrEqual(36);
    }
  });
});
