import { describe, expect, it } from 'vitest';
import { FFT, hannWindow } from '../src/audio/fft';
import { frameCount, istft, magnitude, stft } from '../src/audio/stft';

function naiveDft(re: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(a);
      outIm[k] += re[t] * Math.sin(a);
    }
  }
  return { re: outRe, im: outIm };
}

describe('FFT', () => {
  it('matches a naive DFT', () => {
    const n = 64;
    const x = new Float64Array(n).map((_, i) => Math.sin(i * 0.3) + 0.5 * Math.cos(i * 1.7));
    const expected = naiveDft(x);
    const re = x.slice();
    const im = new Float64Array(n);
    new FFT(n).forward(re, im);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(expected.re[k], 6);
      expect(im[k]).toBeCloseTo(expected.im[k], 6);
    }
  });

  it('inverse undoes forward', () => {
    const n = 256;
    const x = new Float64Array(n).map(() => Math.random() - 0.5);
    const re = x.slice();
    const im = new Float64Array(n);
    const fft = new FFT(n);
    fft.forward(re, im);
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(x[i], 8);
      expect(im[i]).toBeCloseTo(0, 8);
    }
  });

  it('rejects non power-of-two sizes', () => {
    expect(() => new FFT(100)).toThrow();
  });

  it('periodic Hann window matches TensorFlow definition', () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[4]).toBeCloseTo(1, 12);
    // periodic: w[1] === w[7]
    expect(w[1]).toBeCloseTo(w[7], 12);
  });
});

describe('STFT', () => {
  it('frame count matches tf.signal.stft without padding', () => {
    expect(frameCount(144000, 2048, 278)).toBe(511);
    expect(frameCount(144000, 1024, 280)).toBe(511);
    expect(frameCount(1000, 2048, 278)).toBe(0);
  });

  it('finds the frequency of a pure tone', () => {
    const sr = 48000;
    const f = 3000;
    const sig = new Float32Array(sr).map((_, i) => Math.sin((2 * Math.PI * f * i) / sr));
    const s = stft(sig, 1024, 512);
    const mag = magnitude(s);
    const binHz = sr / 1024;
    let best = 0;
    for (let k = 1; k < s.bins; k++) if (mag[k] > mag[best]) best = k;
    expect(Math.abs(best * binHz - f)).toBeLessThan(binHz);
  });

  it('istft reconstructs the signal in the fully-overlapped region', () => {
    const n = 8192;
    const sig = new Float32Array(n).map((_, i) => Math.sin(i * 0.05) * 0.5);
    const s = stft(sig, 1024, 256);
    const back = istft(s, n);
    for (let i = 1024; i < n - 1024; i += 97) expect(back[i]).toBeCloseTo(sig[i], 4);
  });
});
