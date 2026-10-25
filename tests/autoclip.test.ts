import { describe, expect, it } from 'vitest';
import { AUTO_CLIP_MIN_GAP_MS, shouldAutoSaveClip } from '../src/app/autoclip';

describe('auto-saved detection windows: a new clip only when more confident (DECISIONS.md #96)', () => {
  const t0 = 1_000_000;
  it('saves the first clip of a bird at or above the auto-save minimum', () => {
    expect(shouldAutoSaveClip(undefined, 0.74, 0.7, t0)).toBe(true);
    expect(shouldAutoSaveClip(undefined, 0.69, 0.7, t0)).toBe(false);
  });

  it('skips a bird that keeps calling at the same or lower confidence, however long it goes on', () => {
    const last = { time: t0, confidence: 0.84 };
    expect(shouldAutoSaveClip(last, 0.83, 0.7, t0 + 10 * 60_000)).toBe(false);
    expect(shouldAutoSaveClip(last, 0.84, 0.7, t0 + 10 * 60_000)).toBe(false);
  });

  it('saves a more confident clip, but not an overlapping window of the same call', () => {
    const last = { time: t0, confidence: 0.74 };
    expect(shouldAutoSaveClip(last, 0.84, 0.7, t0 + AUTO_CLIP_MIN_GAP_MS - 1)).toBe(false);
    expect(shouldAutoSaveClip(last, 0.84, 0.7, t0 + AUTO_CLIP_MIN_GAP_MS)).toBe(true);
  });
});
