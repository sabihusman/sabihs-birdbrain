import { stft, istft, type Stft } from '../audio/stft';

/** Analysis STFT used for occlusion masking (independent of the model's own front end). */
export const OCCLUSION_FRAME = 1024;
export const OCCLUSION_HOP = 256;

export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

export function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

/** Band edges in Hz on a mel scale from 0 to fmax (n + 1 edges). */
export function melBandEdges(bands: number, fmax: number, fmin = 0): number[] {
  const lo = hzToMel(fmin);
  const hi = hzToMel(fmax);
  const edges: number[] = [];
  for (let i = 0; i <= bands; i++) edges.push(Math.round(melToHz(lo + ((hi - lo) * i) / bands)));
  return edges;
}

export interface OcclusionRegion {
  frameLo: number;
  frameHi: number;
  binLo: number;
  binHi: number;
}

/** Map a grid cell to STFT frames and bins. */
export function regionFor(s: Stft, sampleRate: number, t: number, timeSteps: number, bandEdgesHz: number[], f: number): OcclusionRegion {
  const frameLo = Math.floor((s.frames * t) / timeSteps);
  const frameHi = Math.floor((s.frames * (t + 1)) / timeSteps);
  const hzPerBin = sampleRate / s.frameLength;
  const binLo = Math.floor(bandEdgesHz[f] / hzPerBin);
  const binHi = Math.min(s.bins, Math.ceil(bandEdgesHz[f + 1] / hzPerBin));
  return { frameLo, frameHi, binLo, binHi };
}

/** Return a copy of the STFT with one time-frequency region zeroed. */
export function maskRegion(s: Stft, r: OcclusionRegion): Stft {
  const re = s.re.slice();
  const im = s.im.slice();
  for (let fr = r.frameLo; fr < r.frameHi; fr++) {
    const o = fr * s.bins;
    re.fill(0, o + r.binLo, o + r.binHi);
    im.fill(0, o + r.binLo, o + r.binHi);
  }
  return { ...s, re, im };
}

/** Audio with one time-frequency region removed. */
export function occludeAudio(audio: Float32Array, s: Stft, r: OcclusionRegion): Float32Array {
  return istft(maskRegion(s, r), audio.length);
}

export function analysisStft(audio: Float32Array): Stft {
  return stft(audio, OCCLUSION_FRAME, OCCLUSION_HOP);
}

export const OCCLUSION_GRIDS = {
  coarse: { timeSteps: 6, freqBands: 4 },
  medium: { timeSteps: 8, freqBands: 6 },
  fine: { timeSteps: 12, freqBands: 8 },
} as const;
