import { describe, expect, it } from 'vitest';
import { CLIP_MAX_SECONDS, clipFocus, clipRange, saveClipIfBetter, shouldReplaceClip, sliceClip } from '../src/species/clips';
import { getClip } from '../src/storage/db';

describe('species clip: replace-if-higher', () => {
  it('saves when the species has no clip yet', () => {
    expect(shouldReplaceClip(null, { confidence: 0.3 })).toBe(true);
    expect(shouldReplaceClip(undefined, { confidence: 0.05 })).toBe(true);
  });
  it('replaces only when the new confidence is strictly higher', () => {
    expect(shouldReplaceClip({ confidence: 0.6 }, { confidence: 0.61 })).toBe(true);
    expect(shouldReplaceClip({ confidence: 0.6 }, { confidence: 0.6 })).toBe(false);
    expect(shouldReplaceClip({ confidence: 0.6 }, { confidence: 0.2 })).toBe(false);
  });
});

describe('species clip: 10 s cap and centring', () => {
  it('is capped at 10 seconds', () => {
    expect(CLIP_MAX_SECONDS).toBe(10);
    const r = clipRange({ start: 30, end: 33 }, { start: 0, end: 60 });
    expect(r.end - r.start).toBe(10);
    expect(r).toEqual({ start: 26.5, end: 36.5 }); // centred on the 3 s window (midpoint 31.5)
  });
  it('shifts to stay inside the audio near the start and end', () => {
    expect(clipRange({ start: 0, end: 3 }, { start: 0, end: 60 })).toEqual({ start: 0, end: 10 });
    expect(clipRange({ start: 57, end: 60 }, { start: 0, end: 60 })).toEqual({ start: 50, end: 60 });
  });
  it('shrinks only when less than 10 s of audio exists', () => {
    expect(clipRange({ start: 0, end: 3 }, { start: 0, end: 4 })).toEqual({ start: 0, end: 4 });
    expect(clipRange({ start: 10, end: 13 }, { start: 10, end: 10 })).toEqual({ start: 10, end: 10 });
  });
  it('centres on a span longer than the cap', () => {
    const r = clipRange({ start: 10, end: 30 }, { start: 0, end: 60 });
    expect(r).toEqual({ start: 15, end: 25 });
  });
  it('focus covers all windows when they fit, else the best one', () => {
    expect(clipFocus([{ offsetSec: 4.5, confidence: 0.4 }, { offsetSec: 9, confidence: 0.5 }])).toEqual({ start: 4.5, end: 12 });
    expect(clipFocus([{ offsetSec: 0, confidence: 0.4 }, { offsetSec: 30, confidence: 0.9 }, { offsetSec: 45, confidence: 0.1 }])).toEqual({ start: 30, end: 33 });
  });
  it('live rolling buffer: a window near the buffer end gets what exists so far', () => {
    // Ring holds [20 s, 40 s); the window at 36–39 s cannot be centred yet.
    expect(clipRange({ start: 36, end: 39 }, { start: 20, end: 40 })).toEqual({ start: 30, end: 40 });
  });
  it('sliceClip never exceeds the cap or the buffer', () => {
    const audio = new Float32Array(48000 * 12);
    const cut = sliceClip(audio, clipRange({ start: 5, end: 8 }, { start: 0, end: 12 }));
    expect(cut.length).toBe(48000 * 10);
    expect(sliceClip(audio, { start: 10, end: 30 }).length).toBe(48000 * 2);
  });
});

describe('species clip: storage', () => {
  const cand = { scientific: 'Testus birdus', common: 'Test Bird', time: 1000, lat: null, lon: null, accuracy: null, source: 'live' as const, recordingId: null };
  it('keeps one raw WAV per species and applies the rule at save time', async () => {
    const a = await saveClipIfBetter({ ...cand, confidence: 0.4 }, new Float32Array(48000 * 2).fill(0.1));
    expect(a?.durationSec).toBe(2);
    expect(a?.blob.type).toBe('audio/wav');
    expect(a?.blob.size).toBe(44 + 48000 * 2 * 2);
    expect(await saveClipIfBetter({ ...cand, confidence: 0.3 }, new Float32Array(48000))).toBeNull();
    expect((await getClip(cand.scientific))?.confidence).toBe(0.4);
    const b = await saveClipIfBetter({ ...cand, confidence: 0.9, time: 2000 }, new Float32Array(48000 * 10));
    expect(b?.confidence).toBe(0.9);
    expect((await getClip(cand.scientific))?.time).toBe(2000);
  });
  it('ignores empty audio', async () => {
    expect(await saveClipIfBetter({ ...cand, scientific: 'Empty', confidence: 0.9 }, new Float32Array(0))).toBeNull();
  });
});

