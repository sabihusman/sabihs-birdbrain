/**
 * 48 kHz → 32 kHz for BirdNET+ V3.0 (DECISIONS.md #133). The ratio is exactly 3:2, so every output sample sits
 * either on an input sample (even n) or halfway between two (odd n): two fixed windowed-sinc kernels cover it.
 * The kernels low-pass at 15.2 kHz, under the new Nyquist frequency (16 kHz), so content between 16 and 24 kHz
 * does not fold back into the bird range. About 6 million multiply-adds per 3-second window.
 */
const HALF_TAPS = 32;
const CUTOFF_HZ = 15200;
const IN_RATE = 48000;

function kernel(phase: number): Float32Array {
  // Taps at input offsets -HALF_TAPS+1 … HALF_TAPS relative to floor(position), sampled at (k - phase).
  const fc = CUTOFF_HZ / IN_RATE; // cycles per input sample
  const taps = new Float32Array(2 * HALF_TAPS);
  let sum = 0;
  for (let j = 0; j < taps.length; j++) {
    const d = j - HALF_TAPS + 1 - phase;
    const sinc = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
    // Blackman window over the kernel's span.
    const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / HALF_TAPS) + 0.08 * Math.cos((2 * Math.PI * d) / HALF_TAPS);
    taps[j] = sinc * Math.max(0, w);
    sum += taps[j];
  }
  for (let j = 0; j < taps.length; j++) taps[j] /= sum; // unity gain at 0 Hz
  return taps;
}

const KERNELS = [kernel(0), kernel(0.5)];

/** 48 kHz in, 32 kHz out (two thirds of the length, rounded down). Samples outside the input count as silence. */
export function resample48to32(input: Float32Array): Float32Array {
  const outLen = Math.floor((input.length * 2) / 3);
  const out = new Float32Array(outLen);
  for (let n = 0; n < outLen; n++) {
    const pos = (n * 3) / 2;
    const base = Math.floor(pos);
    const taps = KERNELS[pos === base ? 0 : 1];
    const start = base - HALF_TAPS + 1;
    let acc = 0;
    if (start >= 0 && start + taps.length <= input.length) {
      for (let j = 0; j < taps.length; j++) acc += taps[j] * input[start + j];
    } else {
      for (let j = 0; j < taps.length; j++) {
        const i = start + j;
        if (i >= 0 && i < input.length) acc += taps[j] * input[i];
      }
    }
    out[n] = acc;
  }
  return out;
}
