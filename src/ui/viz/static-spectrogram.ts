/**
 * Spectrogram data for a whole clip, computed with our own STFT and no DOM, so
 * the ID card's clip spectrogram and the recording view share one
 * implementation and the numbers can be unit-tested in Node. Drawing (canvas,
 * colour map) stays in spectrogram.ts.
 */
import { FFT, hannWindow } from '../../audio/fft';
import { stft } from '../../audio/stft';
import { SAMPLE_RATE } from '../../model/constants';
import { AdaptiveDbRange, columnDb, maxOf } from './autoscale';

export const SPEC_FFT = 1024;
export const SPEC_MAX_HZ = 15000;
/** A full-scale sine through a Hann window peaks at N/4 in the FFT, so 4/N reads 0 dBFS. */
export const SPEC_MAG_SCALE = 4 / SPEC_FFT;
/** Highest FFT bin shown (SPEC_MAX_HZ). */
export const SPEC_MAX_BIN = Math.floor((SPEC_MAX_HZ / SAMPLE_RATE) * SPEC_FFT);

export interface StaticSpectrogram {
  /** Number of STFT frames (columns of data, not pixels). */
  frames: number;
  rows: number;
  /** dB per frame and row, [frame * rows + row]; row 0 is the highest frequency. */
  db: Float32Array;
  /** Colour window, dBFS: the top is the loudest bin of the clip (never below −70), the bottom 60 dB under it. */
  topDb: number;
  bottomDb: number;
  durationSec: number;
  hop: number;
}

/**
 * STFT frames of `audio` sized for an image `columns` wide: the hop is chosen
 * so there is about one frame per column (never below 256 samples), and one
 * fixed colour window covers the whole clip, set from its loudest bin.
 */
export function computeStaticSpectrogram(audio: Float32Array, columns: number, rows: number, fft: FFT = new FFT(SPEC_FFT), window: Float64Array = hannWindow(SPEC_FFT)): StaticSpectrogram {
  const hop = Math.max(256, Math.floor(audio.length / Math.max(1, columns)));
  const s = stft(audio, SPEC_FFT, hop, window, fft);
  const db = new Float32Array(s.frames * rows);
  const re = new Float64Array(SPEC_FFT);
  const im = new Float64Array(SPEC_FFT);
  let peakDb = -Infinity;
  for (let f = 0; f < s.frames; f++) {
    const o = f * s.bins;
    for (let k = 0; k < s.bins; k++) {
      re[k] = s.re[o + k];
      im[k] = s.im[o + k];
    }
    const col = columnDb(re, im, rows, SPEC_MAX_BIN, SPEC_MAG_SCALE, db.subarray(f * rows, (f + 1) * rows));
    peakDb = Math.max(peakDb, maxOf(col));
  }
  const range = new AdaptiveDbRange();
  range.reset(Math.max(peakDb, -70));
  return { frames: s.frames, rows, db, topDb: range.topDb, bottomDb: range.bottomDb, durationSec: audio.length / SAMPLE_RATE, hop };
}

/** Pixel column for STFT frame `frame` in an image `width` wide. */
export function frameX(frame: number, frames: number, width: number): number {
  return Math.floor((frame / Math.max(1, frames)) * width);
}

/** Pixel x of a time inside a visible span (shared by the recording and clip views). */
export function timeToX(sec: number, leftSec: number, spanSec: number, width: number): number {
  return ((sec - leftSec) / spanSec) * width;
}

/** Inverse of timeToX. */
export function xToTime(x: number, leftSec: number, spanSec: number, width: number): number {
  return leftSec + (x / width) * spanSec;
}

/** Pixel y of a frequency on the linear 0…SPEC_MAX_HZ axis (row 0 at the top). */
export function hzToY(hz: number, height: number): number {
  return height - (Math.min(SPEC_MAX_HZ, Math.max(0, hz)) / SPEC_MAX_HZ) * height;
}
