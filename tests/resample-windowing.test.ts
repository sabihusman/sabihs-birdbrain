import { describe, expect, it } from 'vitest';
import { resampleLinear, StreamingResampler } from '../src/audio/resample';
import { extractWindow, planWindows, Windower } from '../src/audio/windowing';

describe('resampleLinear', () => {
  it('returns a copy when rates match', () => {
    const x = new Float32Array([1, 2, 3]);
    const y = resampleLinear(x, 48000, 48000);
    expect(Array.from(y)).toEqual([1, 2, 3]);
    expect(y).not.toBe(x);
  });

  it('produces the expected length when upsampling 44.1k -> 48k', () => {
    const x = new Float32Array(44100);
    expect(resampleLinear(x, 44100, 48000).length).toBe(48000);
  });

  it('preserves the frequency of a tone', () => {
    const from = 44100;
    const to = 48000;
    const f = 1000;
    const x = new Float32Array(from).map((_, i) => Math.sin((2 * Math.PI * f * i) / from));
    const y = resampleLinear(x, from, to);
    // count zero crossings over one second
    let crossings = 0;
    for (let i = 1; i < y.length; i++) if ((y[i - 1] < 0 && y[i] >= 0) || (y[i - 1] >= 0 && y[i] < 0)) crossings++;
    expect(Math.abs(crossings / 2 - f)).toBeLessThan(3);
  });
});

describe('StreamingResampler', () => {
  it('matches one-shot resampling to within interpolation error across chunk boundaries', () => {
    const from = 44100;
    const to = 48000;
    const x = new Float32Array(44100).map((_, i) => Math.sin(i * 0.01));
    const whole = resampleLinear(x, from, to);
    const r = new StreamingResampler(from, to);
    const parts: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 1000) parts.push(r.process(x.subarray(i, Math.min(i + 1000, x.length))));
    const total = parts.reduce((n, p) => n + p.length, 0);
    expect(Math.abs(total - whole.length)).toBeLessThanOrEqual(2);
    const streamed = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      streamed.set(p, o);
      o += p.length;
    }
    for (let i = 0; i < Math.min(total, whole.length) - 2; i += 37) expect(streamed[i]).toBeCloseTo(whole[i], 3);
  });

  it('passes audio through unchanged when rates match', () => {
    const r = new StreamingResampler(48000, 48000);
    const chunk = new Float32Array([0.1, 0.2]);
    expect(r.process(chunk)).toBe(chunk);
  });
});

describe('Windower', () => {
  it('emits overlapping windows of the right size and offsets', () => {
    const w = new Windower(10, 4);
    const out: Array<{ window: Float32Array; offsetSamples: number }> = [];
    for (let i = 0; i < 30; i += 7) {
      const chunk = new Float32Array(7).map((_, k) => i + k);
      out.push(...w.push(chunk));
    }
    // 35 samples pushed: windows start at 0, 4, 8, 12, 16, 20 (20+10 = 30 <= 35), 24 (34 <= 35)
    expect(out.map((o) => o.offsetSamples)).toEqual([0, 4, 8, 12, 16, 20, 24]);
    for (const o of out) {
      expect(o.window.length).toBe(10);
      expect(Array.from(o.window)).toEqual(Array.from({ length: 10 }, (_, k) => o.offsetSamples + k));
    }
  });

  it('rejects an invalid hop', () => {
    expect(() => new Windower(10, 0)).toThrow();
    expect(() => new Windower(10, 11)).toThrow();
  });
});

describe('planWindows', () => {
  it('covers a long signal with hop and pads a tail >= min length', () => {
    const plan = planWindows(100, 30, 15, 10);
    expect(plan.map((p) => p.offsetSamples)).toEqual([0, 15, 30, 45, 60, 75]);
    expect(plan[plan.length - 1].padded).toBe(true);
  });

  it('drops a tail shorter than the minimum', () => {
    const plan = planWindows(65, 30, 30, 10);
    expect(plan.map((p) => p.offsetSamples)).toEqual([0, 30]);
  });

  it('pads a single short signal', () => {
    const plan = planWindows(20, 30, 30, 10);
    expect(plan).toEqual([{ offsetSamples: 0, padded: true }]);
    const w = extractWindow(new Float32Array(20).fill(1), 0, 30);
    expect(w.length).toBe(30);
    expect(w[19]).toBe(1);
    expect(w[20]).toBe(0);
  });

  it('returns nothing for empty input', () => {
    expect(planWindows(0, 30, 30, 10)).toEqual([]);
  });
});
