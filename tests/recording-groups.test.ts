import { describe, expect, it } from 'vitest';
import { groupRecordingsByBird } from '../src/species/recording-groups';
import type { RecordingMeta } from '../src/storage/types';

const rec = (id: string, createdAt: number, birds: Array<[string, string, number]>): RecordingMeta =>
  ({
    id,
    name: `Detection window: ${birds[0]?.[1] ?? '?'}`,
    createdAt,
    durationSec: 3,
    sampleRate: 48000,
    bytes: 288000,
    source: 'autoclip',
    summary: birds.map(([scientific, common, maxConfidence]) => ({ label: `${scientific}_${common}`, scientific, common, maxConfidence, count: 1 })),
    analyzedAt: createdAt,
  }) as unknown as RecordingMeta;

describe('Recordings grouped by bird (DECISIONS.md #97)', () => {
  it('puts every clip of a bird in one group, newest group first, newest clip first', () => {
    const grackle: [string, string, number] = ['Quiscalus quiscula', 'Common Grackle', 0.84];
    const groups = groupRecordingsByBird([
      rec('k', 1000, [['Regulus satrapa', 'Golden-crowned Kinglet', 0.87]]),
      rec('g1', 2000, [[grackle[0], grackle[1], 0.74]]),
      rec('g2', 3000, [grackle]),
      rec('g3', 4000, [[grackle[0], grackle[1], 0.83]]),
    ]);
    expect(groups.map((g) => g.common)).toEqual(['Common Grackle', 'Golden-crowned Kinglet']);
    expect(groups[0].recordings.map((r) => r.id)).toEqual(['g3', 'g2', 'g1']);
    expect(groups[0].best).toBe(0.84);
    expect(groups[0].latest).toBe(4000);
  });

  it('groups by the most confident bird of each recording, and keeps recordings with no bird together', () => {
    const groups = groupRecordingsByBird([
      rec('a', 1, [['Turdus migratorius', 'American Robin', 0.9], ['Quiscalus quiscula', 'Common Grackle', 0.7]]),
      rec('b', 2, []),
      rec('c', 3, []),
    ]);
    expect(groups.map((g) => [g.scientific, g.recordings.length])).toEqual([[null, 2], ['Turdus migratorius', 1]]);
  });
});
