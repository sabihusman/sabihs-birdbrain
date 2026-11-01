import { describe, expect, it } from 'vitest';
import { effectiveLayout } from '../src/app/access';
import { lcdClock, levelSegments, specLine } from '../src/ui/birdamp/lcd';
import { countLine, filterRows, heardRows, marqueeBird, nearRows, sightingRows } from '../src/ui/birdamp/library';
import { BIRDAMP_WINDOWS_KEY, defaultWindows, hiddenWindows, loadWindows, moveWindow, moveWindowTo, parseWindows, saveWindows, setWindowState, toggleWindow } from '../src/ui/birdamp/windows';
import { MemoryStorage } from './helpers/memory-storage';

const user = (status: 'approved' | 'pending') => ({ id: 'u1', email: 'a@b.co', name: 'a', role: 'member' as const, status });

describe('BirdAmp is for approved members (DECISIONS.md #110)', () => {
  it('shows Focus instead for anyone else, and keeps the other layouts as chosen', () => {
    expect(effectiveLayout('birdamp', user('approved'))).toBe('birdamp');
    expect(effectiveLayout('birdamp', user('pending'))).toBe('focus');
    expect(effectiveLayout('birdamp', null)).toBe('focus');
    expect(effectiveLayout('dock', null)).toBe('dock');
  });
});

describe('BirdAmp windows', () => {
  it('starts with player, confidence, library, all open', () => {
    expect(defaultWindows()).toEqual({ order: ['player', 'confidence', 'library'], state: { player: 'open', confidence: 'open', library: 'open' } });
  });
  it('moves a window by the keyboard and by dragging, clamped to the stack', () => {
    const w = defaultWindows();
    expect(moveWindow(w, 'library', -1).order).toEqual(['player', 'library', 'confidence']);
    expect(moveWindow(w, 'player', -1).order).toEqual(['player', 'confidence', 'library']);
    expect(moveWindowTo(w, 'library', 0).order).toEqual(['library', 'player', 'confidence']);
    expect(moveWindowTo(w, 'player', 9).order).toEqual(['confidence', 'library', 'player']);
  });
  it('minimises, closes and restores; EQ/PL show a window that is not fully open and hide an open one', () => {
    let w = setWindowState(defaultWindows(), 'confidence', 'closed');
    expect(hiddenWindows(w)).toEqual(['confidence']);
    w = toggleWindow(w, 'confidence');
    expect(w.state.confidence).toBe('open');
    w = toggleWindow(w, 'confidence');
    expect(w.state.confidence).toBe('closed');
    w = setWindowState(w, 'library', 'min');
    expect(toggleWindow(w, 'library').state.library).toBe('open');
  });
  it('reads only a sound saved arrangement, and saves per phone', () => {
    expect(parseWindows('nope')).toEqual(defaultWindows());
    expect(parseWindows(JSON.stringify({ order: ['player', 'player', 'library'] })).order).toEqual(['player', 'confidence', 'library']);
    expect(parseWindows(JSON.stringify({ order: ['library', 'player', 'confidence'], state: { player: 'min', library: 'gone' } }))).toEqual({
      order: ['library', 'player', 'confidence'],
      state: { player: 'min', confidence: 'open', library: 'open' },
    });
    const storage = new MemoryStorage();
    saveWindows(moveWindowTo(defaultWindows(), 'library', 0), storage);
    expect(storage.getItem(BIRDAMP_WINDOWS_KEY)).toContain('library');
    expect(loadWindows(storage).order[0]).toBe('library');
  });
});

describe('BirdAmp LCD readouts', () => {
  it('formats the clock like the player', () => {
    expect(lcdClock(0)).toBe('00:00');
    expect(lcdClock(47.9)).toBe('00:47');
    expect(lcdClock(725)).toBe('12:05');
    expect(lcdClock(3723)).toBe('1:02:03');
  });
  it('states only real values on the spec line', () => {
    expect(specLine({ bottomDb: -75.4, topDb: -15 })).toBe('48K · MONO · BIRDNET V2.4 · −75 TO −15 dBFS');
  });
  it('lights the LED meter on the level bar’s scale', () => {
    expect(levelSegments(0)).toBe(0);
    expect(levelSegments(Number.NaN)).toBe(0);
    expect(levelSegments(1)).toBe(6);
    expect(levelSegments(0.1)).toBe(3);
  });
});

describe('BirdAmp Library rows (Sabih’s 2B)', () => {
  const redpoll = { common: 'Lesser Redpoll', scientific: 'Acanthis cabaret' };
  const robin = { common: 'American Robin', scientific: 'Turdus migratorius' };
  it('HEARD: the session’s birds with best, heard count and last time, no duration', () => {
    const at = new Date(2026, 10, 1, 11, 15).getTime();
    const rows = heardRows([{ key: redpoll.scientific, species: redpoll, detections: [{ start: at, end: at, hits: 1, best: 0.95 }], best: 0.95, lastHeard: at, hitCount: 1, soundOnly: false }], 'en-US');
    expect(rows).toEqual([{ scientific: 'Acanthis cabaret', common: 'Lesser Redpoll', detail: 'best 95% · Heard once · last 11:15 AM', right: '95%' }]);
    expect(marqueeBird(redpoll, 0.95)).toBe('Lesser Redpoll — Acanthis cabaret — 95% — Very likely');
  });
  it('TODAY and ALL BIRDS: one row per species from saved sightings, newest first', () => {
    const now = new Date(2026, 10, 1, 12, 0).getTime();
    const today = new Date(2026, 10, 1, 9, 30).getTime();
    const before = new Date(2026, 9, 28, 7, 0).getTime();
    const sightings = [
      { ...robin, lastTime: before, peakConfidence: 0.8 },
      { ...redpoll, lastTime: today, peakConfidence: 0.7 },
      { ...robin, lastTime: today - 60_000, peakConfidence: 0.9 },
    ];
    const all = sightingRows(sightings, { now, locale: 'en-US' });
    expect(all.map((r) => r.common)).toEqual(['Lesser Redpoll', 'American Robin']);
    expect(all[1].detail).toBe('best 90% · Seen twice · last 9:29 AM');
    const todayRows = sightingRows(sightings, { since: new Date(2026, 10, 1).getTime(), now, locale: 'en-US' });
    expect(todayRows.find((r) => r.common === 'American Robin')?.detail).toBe('best 90% · Seen once · last 9:29 AM');
    expect(sightingRows([{ ...robin, lastTime: before, peakConfidence: 0.8 }], { now, locale: 'en-US' })[0].detail).toBe('best 80% · Seen once · last Oct 28');
  });
  it('NEAR YOU: alphabetical, ✓ for spotted birds; search matches either name', () => {
    const rows = nearRows([redpoll, robin], new Set(['Turdus migratorius']));
    expect(rows.map((r) => [r.common, r.right])).toEqual([
      ['American Robin', '✓'],
      ['Lesser Redpoll', ''],
    ]);
    expect(filterRows(rows, 'acanth').map((r) => r.common)).toEqual(['Lesser Redpoll']);
    expect(filterRows(rows, '  ')).toHaveLength(2);
  });
  it('says the count in the app’s own words', () => {
    expect(countLine('heard', { rows: 2, detections: 3 })).toBe('2 birds · 3 detections · repeats within 30 s count once');
    expect(countLine('heard', { rows: 0 })).toBe('No birds yet this session');
    expect(countLine('near', { rows: 212, place: 'Johnston' })).toBe('212 species near Johnston · ✓ = you’ve spotted it');
    expect(countLine('near', { rows: 0, noLocation: 'All species: location filter off (Settings › Location).' })).toBe('All species: location filter off (Settings › Location).');
  });
});
