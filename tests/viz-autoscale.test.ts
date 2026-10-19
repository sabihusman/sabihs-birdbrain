import { describe, expect, it } from 'vitest';
import { FFT, hannWindow } from '../src/audio/fft';
import { SAMPLE_RATE } from '../src/model/constants';
import { AdaptiveDbRange, columnDb, formatGain, gainForPeak, MAX_WAVEFORM_GAIN, maxOf, PeakFollower } from '../src/ui/viz/autoscale';
import { WaveformView } from '../src/ui/viz/waveform';

const sine = (hz: number, amp: number, seconds: number) => new Float32Array(Math.round(SAMPLE_RATE * seconds)).map((_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));

/** The view only touches the canvas in draw(); columns() is enough to measure what would be drawn. */
const view = () => new WaveformView({} as HTMLCanvasElement);

describe('waveform auto-gain', () => {
  it('a quiet sine (−40 dBFS, peak 0.01) produces a visible trace', () => {
    const w = view();
    w.push(sine(3000, 0.01, 3));
    const cols = w.columns(300, 56);
    const tallest = Math.max(...cols.map((c) => c.bottom - c.top));
    expect(w.gain).toBe(100);
    expect(tallest).toBeGreaterThan(0.8 * 56);
    expect(formatGain(w.gain)).toBe('×100');
  });

  it('without auto-gain the same input would be a flat line (the bug)', () => {
    const peak = 0.01;
    const mid = 56 / 2;
    expect(Math.max(0.5, peak * mid)).toBeLessThan(1); // 0.28 px before the clamp
  });

  it('loud input is not amplified and the gain is readable', () => {
    const w = view();
    w.push(sine(1000, 0.9, 3));
    w.columns(100, 56);
    expect(w.gain).toBe(1);
    expect(gainForPeak(0.02)).toBe(50);
    expect(gainForPeak(0.13)).toBe(8);
    expect(gainForPeak(0.7)).toBe(1);
    expect(gainForPeak(0)).toBe(MAX_WAVEFORM_GAIN);
    expect(gainForPeak(0.0001)).toBe(MAX_WAVEFORM_GAIN);
  });

  it('the gain follows a loud burst down slowly rather than flickering', () => {
    const f = new PeakFollower(0.9);
    f.update(0.5);
    expect(f.update(0.01)).toBeCloseTo(0.45, 5);
    expect(f.update(0.01)).toBeCloseTo(0.405, 5);
    let v = 0;
    for (let i = 0; i < 100; i++) v = f.update(0.01);
    expect(v).toBeCloseTo(0.01, 5);
    const w = view();
    w.push(sine(1000, 0.5, 3));
    w.columns(10, 56);
    expect(w.gain).toBe(2);
    const quiet = view(); // reset() draws, which needs a real canvas
    quiet.push(sine(1000, 0.01, 3));
    quiet.columns(10, 56);
    expect(quiet.gain).toBe(100);
  });
});

describe('spectrogram adaptive dB range', () => {
  it('a quiet sine lands at the top of the colour map once the range has adapted', () => {
    const n = 1024;
    const fft = new FFT(n);
    const win = hannWindow(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const s = sine(3000, 0.01, 1);
    for (let i = 0; i < n; i++) re[i] = s[i] * win[i];
    fft.forward(re, im);
    const maxBin = Math.floor((15000 / SAMPLE_RATE) * n);
    const db = columnDb(re, im, 256, maxBin, 4 / n);
    const peakDb = maxOf(db);
    expect(peakDb).toBeGreaterThan(-42);
    expect(peakDb).toBeLessThan(-38); // about −40 dBFS, as the input is
    const range = new AdaptiveDbRange();
    // fixed 0…−80 dBFS window (the old behaviour): the tone is dim
    expect(Math.round(((peakDb + 80) / 80) * 255)).toBeLessThan(140);
    range.update(peakDb);
    expect(range.index(peakDb)).toBe(255);
    expect(range.bottomDb).toBeCloseTo(peakDb - 60, 5);
    // the row at 3 kHz is the bright one
    const rowFor = (hz: number) => 255 - Math.round((hz / 15000) * 255);
    expect(range.index(db[rowFor(3000)])).toBeGreaterThan(240);
    expect(range.index(db[rowFor(10000)])).toBe(0);
  });

  it('releases slowly and never follows silence below −70 dBFS', () => {
    const r = new AdaptiveDbRange(60, 0.25, -70);
    expect(r.topDb).toBe(-70); // starts at the floor, so the first quiet column is bright at once
    r.update(-40);
    expect(r.topDb).toBe(-40);
    r.update(-100);
    expect(r.topDb).toBeCloseTo(-40.25, 5);
    for (let i = 0; i < 1000; i++) r.update(-150);
    expect(r.topDb).toBe(-70);
    expect(r.index(-70)).toBe(255);
    expect(r.index(-130)).toBe(0);
    expect(r.index(-100)).toBe(128);
  });
});
