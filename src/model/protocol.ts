import type { Score } from './postprocess';

export type BackendName = 'webgl' | 'wasm' | 'cpu';
export type BackendPreference = 'auto' | BackendName;

export type WorkerRequest =
  | { type: 'init'; id: number; baseUrl: string; backend: BackendPreference; floor: number }
  | { type: 'set-geo'; id: number; location: { lat: number; lon: number; week: number } | null; threshold: number }
  | { type: 'analyze'; id: number; audio: Float32Array; tag?: unknown }
  | { type: 'analyze-file'; id: number; audio: Float32Array; hopSamples: number }
  | { type: 'occlusion'; id: number; audio: Float32Array; targetIndex: number; timeSteps: number; freqBands: number }
  | { type: 'cancel'; id: number };

export type LoadPhase = 'backend' | 'acoustic' | 'geo' | 'warmup';

export type WorkerResponse =
  | { type: 'progress'; id: number; phase: LoadPhase; loadedBytes: number; totalBytes: number; message: string }
  | { type: 'ready'; id: number; backend: BackendName; loadMs: number; warmupMs: number }
  | { type: 'stage'; id: number; stage: 'spectrogram' | 'network' | 'filter' }
  | { type: 'result'; id: number; scores: Score[]; inferMs: number; geoApplied: boolean; tag?: unknown }
  | { type: 'geo-ready'; id: number; count: number }
  | { type: 'file-window'; id: number; offsetSamples: number; padded: boolean; scores: Score[]; index: number; total: number }
  | { type: 'file-done'; id: number; cancelled: boolean }
  | { type: 'occlusion-progress'; id: number; done: number; total: number }
  | {
      type: 'occlusion-done';
      id: number;
      baseline: number;
      /** Row-major [timeStep][freqBand] drop in confidence when the region is masked. */
      map: Float32Array;
      timeSteps: number;
      freqBands: number;
      bandEdgesHz: number[];
      cancelled: boolean;
    }
  | { type: 'error'; id: number; message: string }
  | { type: 'log'; message: string };
