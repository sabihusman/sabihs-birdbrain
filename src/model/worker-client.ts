import { Emitter } from '../shared/emitter';
import type { BackendName, BackendPreference, LoadPhase, WorkerRequest, WorkerResponse } from './protocol';
import type { Score } from './postprocess';

export interface ModelStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  phase: LoadPhase | null;
  /** 0..1 */
  progress: number;
  /** Bytes downloaded so far and the size of the whole download (MODEL_TOTAL_BYTES), for the Listen panel's "34 MB of 78 MB". */
  loadedBytes: number;
  totalBytes: number;
  message: string;
  backend: BackendName | null;
  loadMs: number;
  warmupMs: number;
}

export interface AnalyzeResult {
  scores: Score[];
  inferMs: number;
  geoApplied: boolean;
}

export interface FileWindowResult {
  offsetSamples: number;
  padded: boolean;
  scores: Score[];
  index: number;
  total: number;
}

export interface OcclusionResult {
  baseline: number;
  map: Float32Array;
  timeSteps: number;
  freqBands: number;
  bandEdgesHz: number[];
  cancelled: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onWindow?: (w: FileWindowResult) => void;
  onProgress?: (done: number, total: number) => void;
}

/** Main-thread handle to the inference Web Worker. */
export class InferenceClient extends Emitter<{ status: ModelStatus; stage: 'spectrogram' | 'network' | 'filter'; log: string }> {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private status: ModelStatus = { state: 'idle', phase: null, progress: 0, loadedBytes: 0, totalBytes: 0, message: 'Model not loaded', backend: null, loadMs: 0, warmupMs: 0 };
  private analyzing = false;

  constructor(worker?: Worker) {
    super();
    this.worker = worker ?? new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      this.setStatus({ ...this.status, state: 'error', message: `Worker error: ${e.message}` });
    };
  }

  getStatus(): ModelStatus {
    return this.status;
  }

  get busy(): boolean {
    return this.analyzing;
  }

  private setStatus(s: ModelStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private request<T>(build: (id: number) => WorkerRequest, transfer: Transferable[] = [], hooks: Partial<Pending> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...hooks });
      this.send(build(id), transfer);
    });
  }

  private handle(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'progress': {
        const frac = msg.totalBytes > 0 ? Math.min(1, msg.loadedBytes / msg.totalBytes) : 0;
        this.setStatus({ ...this.status, state: 'loading', phase: msg.phase, progress: frac, loadedBytes: Math.min(msg.loadedBytes, msg.totalBytes), totalBytes: msg.totalBytes, message: msg.message });
        return;
      }
      case 'ready': {
        this.setStatus({ state: 'ready', phase: null, progress: 1, loadedBytes: this.status.totalBytes, totalBytes: this.status.totalBytes, message: `Ready (${msg.backend})`, backend: msg.backend, loadMs: msg.loadMs, warmupMs: msg.warmupMs });
        this.pending.get(msg.id)?.resolve(undefined);
        this.pending.delete(msg.id);
        return;
      }
      case 'stage':
        this.emit('stage', msg.stage);
        return;
      case 'log':
        this.emit('log', msg.message);
        return;
      case 'result': {
        this.analyzing = false;
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve({ scores: msg.scores, inferMs: msg.inferMs, geoApplied: msg.geoApplied } satisfies AnalyzeResult);
        return;
      }
      case 'local-species': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg.maxProbs);
        break;
      }
      case 'geo-ready': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg.count);
        return;
      }
      case 'file-window':
        this.pending.get(msg.id)?.onWindow?.({ offsetSamples: msg.offsetSamples, padded: msg.padded, scores: msg.scores, index: msg.index, total: msg.total });
        return;
      case 'file-done': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg.cancelled);
        return;
      }
      case 'occlusion-progress':
        this.pending.get(msg.id)?.onProgress?.(msg.done, msg.total);
        return;
      case 'occlusion-done': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve({ baseline: msg.baseline, map: msg.map, timeSteps: msg.timeSteps, freqBands: msg.freqBands, bandEdgesHz: msg.bandEdgesHz, cancelled: msg.cancelled } satisfies OcclusionResult);
        return;
      }
      case 'error': {
        this.analyzing = false;
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (p) p.reject(new Error(msg.message));
        else this.setStatus({ ...this.status, state: 'error', message: msg.message });
        return;
      }
    }
  }

  /** Load the models. Resolves when inference is ready. */
  async init(baseUrl: string, backend: BackendPreference, floor = 0.01): Promise<void> {
    this.setStatus({ ...this.status, state: 'loading', phase: 'backend', progress: 0, message: 'Starting…' });
    try {
      await this.request<void>((id) => ({ type: 'init', id, baseUrl, backend, floor }));
    } catch (e) {
      this.setStatus({ ...this.status, state: 'error', message: (e as Error).message });
      throw e;
    }
  }

  /** Set (or clear) the location/season filter. Resolves with the number of species in range. */
  setGeo(location: { lat: number; lon: number; week: number } | null, threshold: number): Promise<number> {
    return this.request<number>((id) => ({ type: 'set-geo', id, location, threshold }));
  }

  /** Year-round geo scores at a position: per-species maximum over the 48 weeks. */
  localSpecies(lat: number, lon: number): Promise<Float32Array> {
    return this.request<Float32Array>((id) => ({ type: 'local-species', id, lat, lon }));
  }

  /** Run one 3-second window. The buffer is transferred to the worker. */
  analyze(audio: Float32Array, tag?: unknown): Promise<AnalyzeResult> {
    this.analyzing = true;
    return this.request<AnalyzeResult>((id) => ({ type: 'analyze', id, audio, tag }), [audio.buffer]);
  }

  /** Analyse a whole recording; returns a cancel function and a promise of completion (true if cancelled). */
  analyzeFile(audio: Float32Array, hopSamples: number, onWindow: (w: FileWindowResult) => void): { done: Promise<boolean>; cancel: () => void } {
    let id = 0;
    const done = this.request<boolean>(
      (i) => {
        id = i;
        return { type: 'analyze-file', id: i, audio, hopSamples };
      },
      [audio.buffer],
      { onWindow },
    );
    return { done, cancel: () => this.send({ type: 'cancel', id }) };
  }

  occlusion(audio: Float32Array, targetIndex: number, timeSteps: number, freqBands: number, onProgress: (done: number, total: number) => void): { done: Promise<OcclusionResult>; cancel: () => void } {
    let id = 0;
    const done = this.request<OcclusionResult>(
      (i) => {
        id = i;
        return { type: 'occlusion', id: i, audio, targetIndex, timeSteps, freqBands };
      },
      [audio.buffer],
      { onProgress },
    );
    return { done, cancel: () => this.send({ type: 'cancel', id }) };
  }

  terminate(): void {
    this.worker.terminate();
  }
}
