import { describe, expect, it } from 'vitest';
import { cursorSec, cursorX, describeWindows, outlineSpans, seekSecAt, WINDOW_MEANING } from '../src/species/clip-layout';
import { SAMPLE_RATE } from '../src/model/constants';
import { computeStaticSpectrogram, frameX, hzToY, SPEC_MAX_HZ, timeToX, xToTime } from '../src/ui/viz/static-spectrogram';

describe('ID clip layout: outlines, cursor, wording', () => {
  it('outlines the identifying windows, clamped to the clip, with the confidence as the label', () => {
    const spans = outlineSpans({ durationSec: 10, windows: [{ offsetSec: -1.5, confidence: 0.4 }, { offsetSec: 3.5, confidence: 0.912 }, { offsetSec: 8.5, confidence: 0.6 }] });
    expect(spans).toEqual([
      { startSec: 0, endSec: 1.5, confidence: 0.4, label: '40%' },
      { startSec: 3.5, endSec: 6.5, confidence: 0.912, label: '91%' },
      { startSec: 8.5, endSec: 10, confidence: 0.6, label: '60%' },
    ]);
    expect(outlineSpans({ durationSec: 10, windows: [{ offsetSec: 12, confidence: 0.5 }] })).toEqual([]);
  });
  it('unknown windows (legacy clip) give no outlines, not an empty list', () => {
    expect(outlineSpans({ durationSec: 10 })).toBeNull();
  });
  it('window rectangles follow the shared time-to-x mapping', () => {
    expect(timeToX(3.5, 0, 10, 500)).toBe(175);
    expect(timeToX(6.5, 0, 10, 500)).toBe(325);
    expect(xToTime(175, 0, 10, 500)).toBe(3.5);
    expect(frameX(0, 500, 500)).toBe(0);
    expect(frameX(499, 500, 500)).toBe(499);
  });
  it('cursor: hidden when stopped at the start, otherwise the time clamped to the clip, mapped to pixels', () => {
    expect(cursorSec(true, 0, 10)).toBeNull();
    expect(cursorSec(true, 2, 10)).toBe(2); // paused mid-way: still shown
    expect(cursorSec(false, 11, 10)).toBe(10);
    expect(cursorSec(false, 1, 0)).toBeNull();
    expect(cursorX(null, 10, 500)).toBeNull();
    expect(cursorX(2.5, 10, 500)).toBe(125);
    expect(cursorX(99, 10, 500)).toBe(500);
  });
  it('tap to seek maps x to clip seconds, clamped', () => {
    expect(seekSecAt(100, 400, 10)).toBe(2.5);
    expect(seekSecAt(-5, 400, 10)).toBe(0);
    expect(seekSecAt(900, 400, 10)).toBe(10);
    expect(seekSecAt(10, 0, 10)).toBe(0);
  });
  it('describes the windows, and says when they were not recorded', () => {
    expect(describeWindows([{ offsetSec: 3.5, confidence: 0.73 }])).toBe('Identified in 1 window of 3 s: 0:04–0:07 (73%).');
    expect(describeWindows([{ offsetSec: 0, confidence: 0.5 }, { offsetSec: 61.2, confidence: 0.9 }])).toBe('Identified in 2 windows of 3 s: 0:00–0:03 (50%), 1:01–1:04 (90%).');
    expect(describeWindows(null)).toMatch(/not recorded/);
    expect(describeWindows([])).toMatch(/No identifying window/);
    expect(WINDOW_MEANING).toContain('when a species is heard, not which');
  });
});

describe('static spectrogram data (shared by the clip card and the recording view)', () => {
  const sine = (hz: number, amp: number, seconds: number) => new Float32Array(Math.round(SAMPLE_RATE * seconds)).map((_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
  it('produces about one frame per pixel column and a fixed colour window from the loudest bin', () => {
    // 1031.25 Hz sits exactly on FFT bin 22, and 321 rows give one row per bin, so no interpolation loss.
    const spec = computeStaticSpectrogram(sine(1031.25, 1, 3), 150, 321);
    expect(spec.rows).toBe(321);
    expect(spec.hop).toBe(Math.floor((3 * SAMPLE_RATE) / 150));
    expect(spec.frames).toBeGreaterThanOrEqual(140);
    expect(spec.frames).toBeLessThanOrEqual(150);
    expect(spec.db.length).toBe(spec.frames * 321);
    expect(spec.durationSec).toBe(3);
    // A full-scale sine reads about 0 dBFS; the window is 60 dB deep.
    expect(spec.topDb).toBeGreaterThan(-1);
    expect(spec.topDb).toBeLessThanOrEqual(0.5);
    expect(spec.bottomDb).toBeCloseTo(spec.topDb - 60, 6);
  });
  it('puts the energy of a 1 kHz tone in the row for 1 kHz (row 0 is the top of the axis)', () => {
    const rows = 150;
    const spec = computeStaticSpectrogram(sine(1000, 0.5, 1), 50, rows);
    const col = spec.db.subarray(10 * rows, 11 * rows);
    let best = 0;
    for (let y = 1; y < rows; y++) if (col[y] > col[best]) best = y;
    const expectedY = Math.round(hzToY(1000, rows - 1));
    expect(Math.abs(best - expectedY)).toBeLessThanOrEqual(2);
    expect(hzToY(0, 100)).toBe(100);
    expect(hzToY(SPEC_MAX_HZ, 100)).toBe(0);
    expect(hzToY(SPEC_MAX_HZ * 2, 100)).toBe(0);
  });
  it('digital silence is not amplified: the colour window top stays at −70 dBFS', () => {
    const spec = computeStaticSpectrogram(new Float32Array(SAMPLE_RATE), 50, 32);
    expect(spec.topDb).toBe(-70);
  });
  it('a clip shorter than one FFT frame has no frames and does not throw', () => {
    const spec = computeStaticSpectrogram(new Float32Array(500), 50, 32);
    expect(spec.frames).toBe(0);
    expect(spec.db.length).toBe(0);
  });
});
