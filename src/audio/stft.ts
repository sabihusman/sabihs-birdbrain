import { FFT, hannWindow } from './fft';

/** Number of full frames tf.signal.stft produces without end padding. */
export function frameCount(length: number, frameLength: number, frameStep: number): number {
  if (length < frameLength) return 0;
  return 1 + Math.floor((length - frameLength) / frameStep);
}

export interface Stft {
  frames: number;
  bins: number;
  frameLength: number;
  frameStep: number;
  /** Row-major [frame][bin]. */
  re: Float32Array;
  im: Float32Array;
}

/**
 * Short-time Fourier transform of a real signal, matching tf.signal.stft with
 * a periodic Hann window, fft_length === frame_length and pad_end=false.
 */
export function stft(
  signal: ArrayLike<number>,
  frameLength: number,
  frameStep: number,
  window: Float64Array = hannWindow(frameLength),
  fft: FFT = new FFT(frameLength),
): Stft {
  const frames = frameCount(signal.length, frameLength, frameStep);
  const bins = frameLength / 2 + 1;
  const re = new Float32Array(frames * bins);
  const im = new Float32Array(frames * bins);
  const bufRe = new Float64Array(frameLength);
  const bufIm = new Float64Array(frameLength);
  for (let f = 0; f < frames; f++) {
    const start = f * frameStep;
    for (let i = 0; i < frameLength; i++) {
      bufRe[i] = signal[start + i] * window[i];
      bufIm[i] = 0;
    }
    fft.forward(bufRe, bufIm);
    const o = f * bins;
    for (let k = 0; k < bins; k++) {
      re[o + k] = bufRe[k];
      im[o + k] = bufIm[k];
    }
  }
  return { frames, bins, frameLength, frameStep, re, im };
}

/** Magnitude spectrogram, row-major [frame][bin]. */
export function magnitude(s: Stft): Float32Array {
  const out = new Float32Array(s.re.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(s.re[i], s.im[i]);
  return out;
}

/**
 * Inverse STFT by weighted overlap-add with window-square normalisation.
 * Exact reconstruction for the analysis window when hop <= frameLength/2.
 */
export function istft(s: Stft, length: number, window: Float64Array = hannWindow(s.frameLength)): Float32Array {
  const { frames, bins, frameLength, frameStep } = s;
  const fft = new FFT(frameLength);
  const out = new Float64Array(length);
  const norm = new Float64Array(length);
  const bufRe = new Float64Array(frameLength);
  const bufIm = new Float64Array(frameLength);
  for (let f = 0; f < frames; f++) {
    const o = f * bins;
    for (let k = 0; k < bins; k++) {
      bufRe[k] = s.re[o + k];
      bufIm[k] = s.im[o + k];
    }
    // Hermitian symmetry for the real signal.
    for (let k = bins; k < frameLength; k++) {
      bufRe[k] = s.re[o + (frameLength - k)];
      bufIm[k] = -s.im[o + (frameLength - k)];
    }
    fft.inverse(bufRe, bufIm);
    const start = f * frameStep;
    for (let i = 0; i < frameLength; i++) {
      const idx = start + i;
      if (idx >= length) break;
      out[idx] += bufRe[i] * window[i];
      norm[idx] += window[i] * window[i];
    }
  }
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) result[i] = norm[i] > 1e-8 ? out[i] / norm[i] : 0;
  return result;
}
