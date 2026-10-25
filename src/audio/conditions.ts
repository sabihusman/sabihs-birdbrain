import { FFT, hannWindow } from './fft';

/**
 * Listening-conditions indicator from the raw (unfiltered) microphone audio.
 * Guidance only; it never blocks listening. Thresholds are deliberately
 * simple and documented here:
 *
 *  - "Too quiet": RMS level below QUIET_DBFS (-50 dBFS) over the last second.
 *    A phone held in a normal outdoor scene sits around -40 to -25 dBFS.
 *  - "Windy": at least WINDY_LOW_RATIO (60%) of the spectral energy below
 *    LOW_BAND_HZ (150 Hz, the same cut as the low-cut filter) while the
 *    level is not "too quiet". Wind, handling and traffic rumble live there;
 *    bird song almost never does.
 *  - "Good": everything else.
 */
export const QUIET_DBFS = -50;
export const WINDY_LOW_RATIO = 0.6;
export const LOW_BAND_HZ = 150;
export const ANALYSIS_BAND_HZ = 15000;
/** Seconds of audio each assessment covers. */
export const CONDITIONS_WINDOW_SEC = 1;

export type ConditionLabel = 'too-quiet' | 'windy' | 'good';

export interface ConditionsMetrics {
  rmsDb: number;
  /** Fraction of spectral energy (up to 15 kHz) that sits below LOW_BAND_HZ. */
  lowFreqRatio: number;
}

export interface ConditionsAssessment extends ConditionsMetrics {
  label: ConditionLabel;
  title: string;
  advice: string;
}

export function assessConditions(m: ConditionsMetrics): ConditionsAssessment {
  if (m.rmsDb < QUIET_DBFS) {
    return { ...m, label: 'too-quiet', title: 'Too quiet', advice: 'Very quiet. Check the mic isn’t covered, or move closer.' };
  }
  if (m.lowFreqRatio >= WINDY_LOW_RATIO) {
    return { ...m, label: 'windy', title: 'Windy', advice: 'Rumble from wind, handling or traffic. Shield the mic or turn from the wind.' };
  }
  return { ...m, label: 'good', title: 'Good', advice: 'Sound looks good.' };
}

/** Compute the metrics for one block of raw samples. */
export function measureConditions(samples: Float32Array, sampleRate: number, fftSize = 2048): ConditionsMetrics {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const rmsDb = 20 * Math.log10(rms + 1e-9);

  const fft = new FFT(fftSize);
  const window = hannWindow(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const hzPerBin = sampleRate / fftSize;
  const lowBins = Math.max(1, Math.round(LOW_BAND_HZ / hzPerBin));
  const topBin = Math.min(fftSize / 2, Math.round(ANALYSIS_BAND_HZ / hzPerBin));
  let low = 0;
  let total = 0;
  let frames = 0;
  for (let start = 0; start + fftSize <= samples.length; start += fftSize) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 1; k < topBin; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if (k < lowBins) low += p;
    }
    frames++;
  }
  const lowFreqRatio = frames === 0 || total <= 0 ? 0 : low / total;
  return { rmsDb, lowFreqRatio };
}

/** Accumulates raw chunks and emits an assessment once per CONDITIONS_WINDOW_SEC. */
export class ConditionsMeter {
  private buffer: Float32Array;
  private filled = 0;
  private last: ConditionsAssessment | null = null;

  constructor(
    private sampleRate: number,
    private onAssessment: (a: ConditionsAssessment) => void,
  ) {
    this.buffer = new Float32Array(Math.round(sampleRate * CONDITIONS_WINDOW_SEC));
  }

  get current(): ConditionsAssessment | null {
    return this.last;
  }

  push(chunk: Float32Array): void {
    let i = 0;
    while (i < chunk.length) {
      const take = Math.min(chunk.length - i, this.buffer.length - this.filled);
      this.buffer.set(chunk.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.buffer.length) {
        this.last = assessConditions(measureConditions(this.buffer, this.sampleRate));
        this.onAssessment(this.last);
        this.filled = 0;
      }
    }
  }

  reset(): void {
    this.filled = 0;
    this.last = null;
  }
}
