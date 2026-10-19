import { describe, expect, it } from 'vitest';
import { describeGroup, detectionTimeLabel, groupRecent, heardLabel, LUMP_GAP_SECONDS, lumpHits, toggleExpanded, type KeyedHit } from '../src/species/recent';

const T = Date.parse('2026-10-19T15:34:00');
const GAP = LUMP_GAP_SECONDS * 1000;
const hit = (sec: number, confidence = 0.8) => ({ time: T + sec * 1000, confidence });

describe('recent: 30 s rolling lump', () => {
  it('the gap is one constant, 30 seconds', () => {
    expect(LUMP_GAP_SECONDS).toBe(30);
  });
  it('hits 29 s apart merge into one detection', () => {
    expect(lumpHits([hit(0), hit(29)], GAP)).toEqual([{ start: T, end: T + 29_000, hits: 2, best: 0.8 }]);
  });
  it('hits 31 s apart stay two detections', () => {
    const d = lumpHits([hit(0), hit(31)], GAP);
    expect(d.map((x) => x.hits)).toEqual([1, 1]);
  });
  it('exactly 30 s apart still counts as one (no more than 30 s between hits)', () => {
    expect(lumpHits([hit(0), hit(30)], GAP)).toHaveLength(1);
  });
  it('a chain of hits each under 30 s apart stays one detection, however long (rolling gap)', () => {
    const chain = Array.from({ length: 20 }, (_, i) => hit(i * 25));
    const d = lumpHits(chain, GAP);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ start: T, end: T + 19 * 25_000, hits: 20 });
  });
  it('keeps the best confidence and tolerates unsorted input', () => {
    const d = lumpHits([hit(18, 0.7), hit(15, 0.9), hit(20, 0.4), hit(17, 1)], GAP);
    expect(d).toEqual([{ start: T + 15_000, end: T + 20_000, hits: 4, best: 1 }]);
  });
  it('the phone sequence: Bluebird at :15 :17 :18 :20 is one detection with 4 hits', () => {
    const d = lumpHits([hit(15), hit(17), hit(18), hit(20)], GAP);
    expect(d).toHaveLength(1);
    expect(d[0].hits).toBe(4);
  });
});

type Sp = { scientific: string; common: string };
const BLUEBIRD: Sp = { scientific: 'Sialia sialis', common: 'Eastern Bluebird' };
const DOVE: Sp = { scientific: 'Zenaida macroura', common: 'Mourning Dove' };
const k = (sp: Sp, sec: number, confidence = 0.8): KeyedHit<Sp> => ({ key: sp.scientific, species: sp, time: T + sec * 1000, confidence });

describe('recent: grouping by species', () => {
  it('one card per species, ordered by last heard, newest first', () => {
    const groups = groupRecent([k(DOVE, 6), k(DOVE, 8), k(DOVE, 9), k(BLUEBIRD, 15), k(BLUEBIRD, 17), k(BLUEBIRD, 18), k(BLUEBIRD, 20)], GAP);
    expect(groups.map((g) => g.species.common)).toEqual(['Eastern Bluebird', 'Mourning Dove']);
    expect(groups.map((g) => g.detections.length)).toEqual([1, 1]);
    expect(groups.map((g) => g.hitCount)).toEqual([4, 3]);
    expect(groups[0].lastHeard).toBe(T + 20_000);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });
  it('a new hit moves the species card to the top and bumps its count when it starts a new detection', () => {
    const base = [k(BLUEBIRD, 0), k(DOVE, 10)];
    expect(groupRecent(base, GAP)[0].species).toBe(DOVE);
    const later = [...base, k(BLUEBIRD, 100)];
    const groups = groupRecent(later, GAP);
    expect(groups[0].species).toBe(BLUEBIRD);
    expect(groups[0].detections.length).toBe(2);
    expect(groups).toHaveLength(2);
  });
  it('a new hit inside the gap extends the current detection instead of adding one', () => {
    const groups = groupRecent([k(BLUEBIRD, 0), k(BLUEBIRD, 20)], GAP);
    expect(groups[0].detections).toEqual([{ start: T, end: T + 20_000, hits: 2, best: 0.8 }]);
    expect(heardLabel(groups[0].detections.length)).toBe('Heard once');
  });
  it('counts are the lumped detections, not raw hits; best is over every hit', () => {
    const groups = groupRecent([k(BLUEBIRD, 0, 0.5), k(BLUEBIRD, 10, 0.95), k(BLUEBIRD, 100, 0.6), k(BLUEBIRD, 200, 0.7)], GAP);
    const g = groups[0];
    expect(g.hitCount).toBe(4);
    expect(g.detections.length).toBe(3);
    expect(heardLabel(g.detections.length)).toBe('Heard 3 times');
    expect(g.best).toBe(0.95);
    expect(g.detections.map((d) => d.start)).toEqual([T + 200_000, T + 100_000, T]); // newest first
  });
  it('ties on last heard are stable by species key', () => {
    const groups = groupRecent([k(DOVE, 5), k(BLUEBIRD, 5)], GAP);
    expect(groups.map((g) => g.key)).toEqual(['Sialia sialis', 'Zenaida macroura']);
  });
});

describe('recent: labels', () => {
  it('describes a group for screen readers', () => {
    const g = groupRecent([k(BLUEBIRD, 15, 0.9), k(BLUEBIRD, 17, 1), k(BLUEBIRD, 100), k(BLUEBIRD, 200), k(BLUEBIRD, 300)], GAP)[0];
    expect(describeGroup(g.species.common, g, 'en-US')).toBe('Eastern Bluebird, heard 4 times, best 100%, last at 3:39 PM');
    expect(describeGroup('Mourning Dove', { detections: [{ start: T, end: T, hits: 1, best: 0.62 }], best: 0.62, lastHeard: T }, 'en-US')).toBe('Mourning Dove, heard once, best 62%, last at 3:34 PM');
  });
  it('a multi-hit detection shows a time range with one AM/PM suffix; a single hit shows one time', () => {
    expect(detectionTimeLabel({ start: T + 15_000, end: T + 20_000, hits: 4, best: 1 }, 'en-US')).toBe('3:34:15–3:34:20 PM');
    expect(detectionTimeLabel({ start: T + 15_000, end: T + 15_000, hits: 1, best: 1 }, 'en-US')).toBe('3:34:15 PM');
  });
  it('expand and collapse toggle per species', () => {
    const open = new Set<string>();
    expect(toggleExpanded(open, 'Sialia sialis')).toBe(true);
    expect(open.has('Sialia sialis')).toBe(true);
    expect(toggleExpanded(open, 'Zenaida macroura')).toBe(true);
    expect(toggleExpanded(open, 'Sialia sialis')).toBe(false);
    expect([...open]).toEqual(['Zenaida macroura']);
  });
});
