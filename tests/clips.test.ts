import { describe, expect, it } from 'vitest';
import { CLIP_MAX_SECONDS, bestByConfidence, clipFocus, clipRange, clipWindows, saveClipIfBetter, shouldReplaceClip, sliceClip, whyWindowFor, windowsInClip } from '../src/species/clips';
import { getClip, putClip } from '../src/storage/db';
import type { ClipRecord } from '../src/storage/types';

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

describe('species clip: best-by-confidence and empty lists', () => {
  it('bestByConfidence returns undefined for an empty list instead of throwing', () => {
    expect(bestByConfidence([])).toBeUndefined();
  });
  it('bestByConfidence picks the highest confidence and keeps the first on a tie', () => {
    const a = { id: 'a', confidence: 0.4 };
    const b = { id: 'b', confidence: 0.9 };
    const c = { id: 'c', confidence: 0.9 };
    expect(bestByConfidence([a, b, c])).toBe(b);
    expect(bestByConfidence([a])).toBe(a);
  });
  it('clipFocus rejects an empty window list with a clear error', () => {
    expect(() => clipFocus([])).toThrow('clipFocus: no windows');
  });
  it('clipFocus with a single window over the cap still returns that window', () => {
    expect(clipFocus([{ offsetSec: 7, confidence: 0.3 }], 1)).toEqual({ start: 7, end: 10 });
  });
});

describe('species clip: storage', () => {
  const cand = { scientific: 'Testus birdus', common: 'Test Bird', time: 1000, lat: null, lon: null, accuracy: null, source: 'live' as const, recordingId: null, windows: [{ offsetSec: 3.5, confidence: 0.4 }] };
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


describe('species clip: identifying windows (DB version 4)', () => {
  const cand = { scientific: 'Windowus testus', common: 'Window Bird', time: 1000, lat: null, lon: null, accuracy: null, source: 'recording' as const, recordingId: 'r1' };

  it('windowsInClip: offsets are window start minus clip start, sorted, partial edge windows kept, outside ones dropped', () => {
    const range = { start: 26.5, end: 36.5 }; // clipRange for a window at 30–33 in a long recording
    const ws = windowsInClip(
      [
        { startSec: 31.5, confidence: 0.7 },
        { startSec: 30, confidence: 0.9 },
        { startSec: 20, confidence: 0.5 }, // ends at 23: outside
        { startSec: 25, confidence: 0.4 }, // 25–28 overlaps the clip start: kept with a negative offset
        { startSec: 36.5, confidence: 0.3 }, // starts at the clip end: outside
        { startSec: 35, confidence: 0.6 }, // 35–38 runs past the end: kept
      ],
      range,
    );
    expect(ws).toEqual([
      { offsetSec: -1.5, confidence: 0.4 },
      { offsetSec: 3.5, confidence: 0.9 },
      { offsetSec: 5, confidence: 0.7 },
      { offsetSec: 8.5, confidence: 0.6 },
    ]);
  });

  it('windowsInClip: live sample arithmetic has no float noise and duplicates keep the higher confidence', () => {
    const SR = 48000;
    const range = { start: 1234567 / SR, end: 1234567 / SR + 10 };
    const ws = windowsInClip(
      [
        { startSec: (1234567 + 3 * SR) / SR, confidence: 0.5 },
        { startSec: (1234567 + 3 * SR) / SR, confidence: 0.8 },
      ],
      range,
    );
    expect(ws).toEqual([{ offsetSec: 3, confidence: 0.8 }]);
  });

  it('saveClipIfBetter stores the windows sorted; clipWindows reads them back', async () => {
    const saved = await saveClipIfBetter({ ...cand, confidence: 0.9, windows: [{ offsetSec: 4.5, confidence: 0.9 }, { offsetSec: 3, confidence: 0.7 }] }, new Float32Array(48000 * 10));
    expect(saved?.windows).toEqual([
      { offsetSec: 3, confidence: 0.7 },
      { offsetSec: 4.5, confidence: 0.9 },
    ]);
    const stored = await getClip(cand.scientific);
    expect(clipWindows(stored!)).toEqual(saved!.windows);
    expect(whyWindowFor(stored!)).toEqual({ offsetSec: 4.5, confidence: 0.9, known: true });
  });

  it('a legacy record without windows reads as unknown windows and runs "Why" on the clip centre', async () => {
    const legacy: ClipRecord = { scientific: 'Legacy bird', common: 'Legacy', blob: new Blob([new Uint8Array(44)], { type: 'audio/wav' }), sampleRate: 48000, durationSec: 10, confidence: 0.5, time: 0, savedAt: 0, lat: null, lon: null, accuracy: null, source: 'live', recordingId: null };
    await putClip(legacy);
    const back = (await getClip('Legacy bird'))!;
    expect(clipWindows(back)).toBeNull();
    expect(whyWindowFor(back)).toEqual({ offsetSec: 3.5, confidence: 0.5, known: false });
    expect(whyWindowFor({ durationSec: 2, confidence: 0.4 })).toEqual({ offsetSec: 0, confidence: 0.4, known: false });
    // The "Why" window never starts past the end of a short clip.
    expect(whyWindowFor({ durationSec: 4, confidence: 0.4, windows: [{ offsetSec: 2.5, confidence: 0.4 }] }).offsetSec).toBe(1);
    // A more confident detection replaces the legacy clip the normal way, now with windows.
    const replaced = await saveClipIfBetter({ ...cand, scientific: 'Legacy bird', confidence: 0.6, windows: [{ offsetSec: 0, confidence: 0.6 }] }, new Float32Array(48000 * 3));
    expect(clipWindows(replaced!)).toEqual([{ offsetSec: 0, confidence: 0.6 }]);
  });
});
