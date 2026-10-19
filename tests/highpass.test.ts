import { describe, expect, it } from 'vitest';
import { applyHighpass, configureLowCut, highpassCoefficients, LOW_CUT_HZ, LOW_CUT_NODE_PARAMS, LOW_CUT_Q_DB, renderLowCut } from '../src/audio/highpass';

function rms(x: Float32Array, from = 0): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - from));
}

function tone(hz: number, sr = 48000, seconds = 1): Float32Array {
  return new Float32Array(sr * seconds).map((_, i) => Math.sin((2 * Math.PI * hz * i) / sr));
}

describe('low-cut filter setup', () => {
  it('is a 150 Hz high-pass with the Web Audio default Q', () => {
    expect(LOW_CUT_HZ).toBe(150);
    expect(LOW_CUT_NODE_PARAMS).toEqual({ type: 'highpass', frequency: 150, Q: LOW_CUT_Q_DB });
    const node = { type: 'lowpass' as BiquadFilterType, frequency: { value: 350 }, Q: { value: 1 } };
    configureLowCut(node);
    expect(node.type).toBe('highpass');
    expect(node.frequency.value).toBe(150);
  });

  it('coefficients are normalised and have unity gain at Nyquist', () => {
    const c = highpassCoefficients(150, 48000);
    // H(z) at z = -1 (Nyquist): (b0 - b1 + b2) / (1 - a1 + a2) should be ~1 for a high-pass.
    const h = (c.b0 - c.b1 + c.b2) / (1 - c.a1 + c.a2);
    expect(h).toBeCloseTo(1, 3);
    // DC gain is zero.
    expect(Math.abs(c.b0 + c.b1 + c.b2)).toBeLessThan(1e-9);
  });

  it('removes 50 Hz rumble and keeps a 2 kHz song', () => {
    const low = applyHighpass(tone(50), 48000);
    const high = applyHighpass(tone(2000), 48000);
    const steady = 24000; // skip the transient
    expect(rms(low, steady)).toBeLessThan(0.15 * Math.SQRT1_2); // > 16 dB down
    expect(rms(high, steady)).toBeGreaterThan(0.95 * Math.SQRT1_2); // essentially unchanged
  });

  it('does not touch the input array', () => {
    const x = tone(100);
    const copy = x.slice();
    applyHighpass(x, 48000);
    expect(x).toEqual(copy);
  });

  it('renderLowCut falls back to the JS filter without Web Audio', async () => {
    const out = await renderLowCut(tone(50), 48000);
    expect(out.length).toBe(48000);
    expect(rms(out, 24000)).toBeLessThan(0.15);
  });
});
