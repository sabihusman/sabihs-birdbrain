/**
 * Auto-scaling for the live visualisations. With echo cancellation, noise
 * suppression and automatic gain off (DECISIONS.md #22), raw phone microphone
 * input peaks around 0.01–0.06 of full scale, which on a fixed ±1 axis is a
 * flat line and on a fixed 0…−80 dBFS colour range is a faint spectrogram.
 * Both views therefore follow the recent peak: fast attack, slow release.
 */

/** Largest waveform gain; below 1/MAX_WAVEFORM_GAIN of full scale the trace stays small (true silence looks quiet). */
export const MAX_WAVEFORM_GAIN = 100;

/** Peak follower: jumps up immediately, decays by `release` per update. */
export class PeakFollower {
  private value = 0;
  constructor(
    private readonly release = 0.9,
    private readonly floor = 1e-4,
  ) {}
  update(instant: number): number {
    this.value = Math.max(instant, this.value * this.release, this.floor);
    return this.value;
  }
  get current(): number {
    return this.value;
  }
  reset(): void {
    this.value = 0;
  }
}

/** Gain that brings `peak` to full scale, rounded to a readable "×N", capped. */
export function gainForPeak(peak: number, maxGain = MAX_WAVEFORM_GAIN): number {
  if (!(peak > 0)) return maxGain;
  const g = Math.min(maxGain, 1 / peak);
  if (g < 1.5) return 1;
  if (g < 10) return Math.round(g);
  return Math.round(g / 5) * 5;
}

export function formatGain(gain: number): string {
  return `×${gain}`;
}

/**
 * Adaptive dB window for the spectrogram: the top follows the loudest bin of
 * recent columns (instant attack, `releaseDbPerColumn` decay), the bottom sits
 * `spanDb` below it. Values map to 0…255 colour-table indices.
 */
export class AdaptiveDbRange {
  private top: number;
  constructor(
    readonly spanDb = 60,
    private readonly releaseDbPerColumn = 0.25,
    /** The top never drops below this, so digital silence is not amplified into a bright noise floor. */
    private readonly minTopDb = -70,
    initialTopDb = minTopDb,
  ) {
    this.top = initialTopDb;
  }
  /** Feed the loudest dB value of a new column; returns the window top. */
  update(columnMaxDb: number): number {
    const decayed = this.top - this.releaseDbPerColumn;
    this.top = Math.max(columnMaxDb, decayed, this.minTopDb);
    return this.top;
  }
  get topDb(): number {
    return this.top;
  }
  get bottomDb(): number {
    return this.top - this.spanDb;
  }
  index(db: number): number {
    const t = (db - this.bottomDb) / this.spanDb;
    return Math.round(Math.max(0, Math.min(1, t)) * 255);
  }
  reset(topDb = this.minTopDb): void {
    this.top = Math.max(topDb, this.minTopDb);
  }
}

/** Magnitude (0…1 full scale) to dBFS. */
export function magToDb(mag: number): number {
  return 20 * Math.log10(mag + 1e-9);
}

/**
 * One spectrogram column in dB per pixel row (row 0 = highest frequency),
 * interpolating linearly between FFT bins. `scale` converts raw FFT magnitudes
 * to full-scale units (4 / fftSize for a Hann-windowed sine).
 */
export function columnDb(re: ArrayLike<number>, im: ArrayLike<number>, rows: number, maxBin: number, scale: number, out: Float32Array = new Float32Array(rows)): Float32Array {
  for (let y = 0; y < rows; y++) {
    const binF = ((rows - 1 - y) / (rows - 1)) * maxBin;
    const b0 = Math.floor(binF);
    const b1 = Math.min(maxBin, b0 + 1);
    const f = binF - b0;
    const m0 = Math.hypot(re[b0], im[b0]) * scale;
    const m1 = Math.hypot(re[b1], im[b1]) * scale;
    out[y] = magToDb(m0 * (1 - f) + m1 * f);
  }
  return out;
}

export function maxOf(values: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}
