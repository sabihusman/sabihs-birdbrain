/**
 * Linear-interpolation resampling. Good enough for 44.1 kHz -> 48 kHz mic
 * audio; imported files go through the browser's decoder instead, which has
 * a proper anti-aliasing filter.
 */

/** One-shot resample of a whole buffer. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input.slice();
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  const last = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, last);
    const frac = pos - i0;
    out[i] = input[Math.min(i0, last)] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** Streaming resampler that keeps fractional phase across chunks. */
export class StreamingResampler {
  private readonly ratio: number;
  private phase = 0; // position in input samples relative to the start of the current chunk
  private prev = 0; // last input sample of the previous chunk
  private hasPrev = false;

  constructor(readonly fromRate: number, readonly toRate: number) {
    this.ratio = fromRate / toRate;
  }

  process(chunk: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return chunk;
    if (chunk.length === 0) return new Float32Array(0);
    // Virtual input: [prev, ...chunk], indices -1..chunk.length-1
    const out: number[] = [];
    let pos = this.phase;
    const maxPos = chunk.length - 1;
    while (pos <= maxPos) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = i0 < 0 ? (this.hasPrev ? this.prev : chunk[0]) : chunk[i0];
      const s1 = chunk[Math.min(i0 + 1, maxPos)];
      out.push(s0 * (1 - frac) + s1 * frac);
      pos += this.ratio;
    }
    this.phase = pos - chunk.length;
    this.prev = chunk[chunk.length - 1];
    this.hasPrev = true;
    return Float32Array.from(out);
  }
}
