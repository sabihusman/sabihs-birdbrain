/**
 * Fixed-length analysis windows with overlap, fed from a stream of chunks.
 */
export class Windower {
  private buffer: Float32Array;
  private filled = 0;
  /** Samples consumed from the stream so far (for timestamps). */
  private consumed = 0;

  constructor(
    readonly windowSamples: number,
    readonly hopSamples: number,
  ) {
    if (hopSamples <= 0 || hopSamples > windowSamples) throw new Error('hop must be in (0, window]');
    this.buffer = new Float32Array(windowSamples);
  }

  /** Push a chunk; returns every complete window it produced, with the offset (in samples) of each window start. */
  push(chunk: Float32Array): Array<{ window: Float32Array; offsetSamples: number }> {
    const out: Array<{ window: Float32Array; offsetSamples: number }> = [];
    let i = 0;
    while (i < chunk.length) {
      const take = Math.min(chunk.length - i, this.windowSamples - this.filled);
      this.buffer.set(chunk.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.windowSamples) {
        out.push({ window: this.buffer.slice(), offsetSamples: this.consumed });
        // Slide by hop: keep the tail for overlap.
        this.buffer.copyWithin(0, this.hopSamples);
        this.filled = this.windowSamples - this.hopSamples;
        this.consumed += this.hopSamples;
      }
    }
    return out;
  }

  reset(): void {
    this.filled = 0;
    this.consumed = 0;
  }
}

export interface WindowPlan {
  offsetSamples: number;
  /** True when the window had to be zero-padded to the full length. */
  padded: boolean;
}

/**
 * Plan windows over a finite signal. Trailing audio shorter than `minSamples`
 * is dropped; between minSamples and windowSamples it is zero-padded.
 */
export function planWindows(totalSamples: number, windowSamples: number, hopSamples: number, minSamples: number): WindowPlan[] {
  const plan: WindowPlan[] = [];
  if (totalSamples <= 0) return plan;
  for (let offset = 0; offset < totalSamples; offset += hopSamples) {
    const remaining = totalSamples - offset;
    if (remaining >= windowSamples) {
      plan.push({ offsetSamples: offset, padded: false });
    } else {
      if (remaining >= minSamples && (plan.length === 0 || plan[plan.length - 1].offsetSamples + windowSamples < totalSamples)) {
        plan.push({ offsetSamples: offset, padded: true });
      }
      break;
    }
  }
  return plan;
}

/** Extract a window of exactly windowSamples, zero-padding past the end. */
export function extractWindow(signal: Float32Array, offsetSamples: number, windowSamples: number): Float32Array {
  const out = new Float32Array(windowSamples);
  const end = Math.min(signal.length, offsetSamples + windowSamples);
  if (end > offsetSamples) out.set(signal.subarray(offsetSamples, end));
  return out;
}
