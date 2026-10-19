import { describe, expect, it } from 'vitest';
import { assessConditions, ConditionsMeter, measureConditions, QUIET_DBFS, WINDY_LOW_RATIO } from '../src/audio/conditions';

const sr = 48000;
const tone = (hz: number, amp: number, n = sr) => new Float32Array(n).map((_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));

describe('conditions indicator', () => {
  it('documented thresholds', () => {
    expect(QUIET_DBFS).toBe(-50);
    expect(WINDY_LOW_RATIO).toBe(0.6);
  });

  it('labels silence as too quiet', () => {
    const a = assessConditions(measureConditions(new Float32Array(sr), sr));
    expect(a.label).toBe('too-quiet');
    expect(a.title).toBe('Too quiet');
  });

  it('labels low rumble as windy', () => {
    const a = assessConditions(measureConditions(tone(40, 0.3), sr));
    expect(a.lowFreqRatio).toBeGreaterThan(0.9);
    expect(a.label).toBe('windy');
  });

  it('labels a bird-like 3 kHz tone as good', () => {
    const a = assessConditions(measureConditions(tone(3000, 0.1), sr));
    expect(a.lowFreqRatio).toBeLessThan(0.05);
    expect(a.label).toBe('good');
  });

  it('a faint rumble is "too quiet", not "windy" (level check comes first)', () => {
    expect(assessConditions({ rmsDb: -60, lowFreqRatio: 0.95 }).label).toBe('too-quiet');
    expect(assessConditions({ rmsDb: -30, lowFreqRatio: 0.61 }).label).toBe('windy');
    expect(assessConditions({ rmsDb: -30, lowFreqRatio: 0.59 }).label).toBe('good');
  });

  it('meter emits once per second of audio', () => {
    const seen: string[] = [];
    const m = new ConditionsMeter(sr, (a) => seen.push(a.label));
    const chunk = tone(3000, 0.1, 2048);
    for (let i = 0; i < 50; i++) m.push(chunk); // 102400 samples ≈ 2.13 s
    expect(seen).toEqual(['good', 'good']);
    expect(m.current?.label).toBe('good');
  });
});
