/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import wasmSimdUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import wasmThreadedUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import wasmUrl from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import { ACOUSTIC_MODEL_JSON, GEO_MODEL_JSON, MODEL_CACHE_NAME, MODEL_TOTAL_BYTES, SAMPLE_RATE, WINDOW_SAMPLES } from './constants';
import { registerMelSpecLayer } from './melspec-layer';
import { analysisStft, melBandEdges, occludeAudio, regionFor } from './occlusion';
import { rankScores, type GeoMask } from './postprocess';
import type { BackendName, BackendPreference, WorkerRequest, WorkerResponse } from './protocol';
import { extractWindow, planWindows } from '../audio/windowing';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let acoustic: tf.LayersModel | null = null;
let geoModel: tf.GraphModel | null = null;
let geoMask: GeoMask | null = null;
let floor = 0.01;
let backendName: BackendName = 'cpu';
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

function log(message: string): void {
  post({ type: 'log', message });
}

const yieldToEvents = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Cache-first fetch for model files using the same Cache API bucket as the
 * service worker's runtime route. The first page load is not yet controlled by
 * the service worker, so without this the model would be downloaded again on
 * the second visit before it ever reached the cache.
 */
async function cachedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let cache: Cache | null = null;
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open(MODEL_CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return hit;
    }
  } catch {
    cache = null;
  }
  const res = await fetch(input, init);
  if (res.ok && cache) {
    try {
      await cache.put(url, res.clone());
    } catch (e) {
      log(`model cache write failed: ${(e as Error).message}`);
    }
  }
  return res;
}

/** fetch wrapper that reports cumulative downloaded bytes. */
function progressFetch(onBytes: (loaded: number) => void): typeof fetch {
  let loaded = 0;
  return async (input, init) => {
    const res = await cachedFetch(input, init);
    if (!res.ok || !res.body) return res;
    const reader = res.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        loaded += value.byteLength;
        onBytes(loaded);
        controller.enqueue(value);
      },
      cancel() {
        void reader.cancel();
      },
    });
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(stream, { status: res.status, statusText: res.statusText, headers });
  };
}

function isSafari(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Android/.test(ua);
}

async function initBackend(pref: BackendPreference): Promise<BackendName> {
  const all: BackendName[] = ['webgl', 'wasm', 'cpu'];
  const order = pref === 'auto' ? all : [pref, ...all.filter((b) => b !== pref)];
  for (const name of order) {
    try {
      if (name === 'webgl') {
        if (typeof OffscreenCanvas === 'undefined') continue;
        // TF.js refuses to create an OffscreenCanvas in Safari and then fails because there is
        // no `document` in a worker. We allow it and disable the GPU fence API it was worried
        // about, so reads fall back to synchronous readPixels.
        if (isSafari()) {
          tf.env().set('IS_SAFARI', false);
          tf.env().set('WEBGL_FENCE_API_ENABLED', false);
        }
      }
      if (name === 'wasm') {
        setWasmPaths({
          'tfjs-backend-wasm.wasm': wasmUrl,
          'tfjs-backend-wasm-simd.wasm': wasmSimdUrl,
          'tfjs-backend-wasm-threaded-simd.wasm': wasmThreadedUrl,
        });
      }
      const ok = await tf.setBackend(name);
      if (!ok) continue;
      await tf.ready();
      return name;
    } catch (e) {
      log(`backend ${name} failed: ${(e as Error).message}`);
    }
  }
  await tf.setBackend('cpu');
  await tf.ready();
  return 'cpu';
}

async function runAcoustic(audio: Float32Array): Promise<Float32Array> {
  if (!acoustic) throw new Error('Model not loaded');
  const input = tf.tensor2d(audio, [1, WINDOW_SAMPLES]);
  try {
    const out = acoustic.predict(input) as tf.Tensor;
    try {
      return (await out.data()) as Float32Array;
    } finally {
      out.dispose();
    }
  } finally {
    input.dispose();
  }
}

async function handleInit(msg: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  const t0 = performance.now();
  floor = msg.floor;
  post({ type: 'progress', id: msg.id, phase: 'backend', loadedBytes: 0, totalBytes: MODEL_TOTAL_BYTES, message: 'Choosing compute backend…' });
  backendName = await initBackend(msg.backend);
  log(`backend: ${backendName}`);
  registerMelSpecLayer();

  const fetchFunc = progressFetch((loaded) => {
    post({ type: 'progress', id: msg.id, phase: 'acoustic', loadedBytes: loaded, totalBytes: MODEL_TOTAL_BYTES, message: `Downloading BirdNET (${(loaded / 1048576).toFixed(0)} MB of ${(MODEL_TOTAL_BYTES / 1048576).toFixed(0)} MB)` });
  });
  acoustic = await tf.loadLayersModel(msg.baseUrl + ACOUSTIC_MODEL_JSON, { fetchFunc });
  post({ type: 'progress', id: msg.id, phase: 'geo', loadedBytes: MODEL_TOTAL_BYTES * 0.64, totalBytes: MODEL_TOTAL_BYTES, message: 'Downloading location model…' });
  geoModel = await tf.loadGraphModel(msg.baseUrl + GEO_MODEL_JSON, { fetchFunc });
  const loadMs = performance.now() - t0;

  post({ type: 'progress', id: msg.id, phase: 'warmup', loadedBytes: MODEL_TOTAL_BYTES, totalBytes: MODEL_TOTAL_BYTES, message: `Warming up on ${backendName}…` });
  const t1 = performance.now();
  await runAcoustic(new Float32Array(WINDOW_SAMPLES));
  const warmupMs = performance.now() - t1;
  log(`loaded in ${loadMs.toFixed(0)} ms, warmup ${warmupMs.toFixed(0)} ms, tensors ${tf.memory().numTensors}`);
  post({ type: 'ready', id: msg.id, backend: backendName, loadMs, warmupMs });
}

async function handleSetGeo(msg: Extract<WorkerRequest, { type: 'set-geo' }>): Promise<void> {
  if (!msg.location || !geoModel) {
    geoMask = null;
    post({ type: 'geo-ready', id: msg.id, count: 0 });
    return;
  }
  const { lat, lon, week } = msg.location;
  const input = tf.tensor2d([[lat, lon, week]]);
  const out = geoModel.predict(input) as tf.Tensor;
  const probs = (await out.data()) as Float32Array;
  input.dispose();
  out.dispose();
  geoMask = { probs, threshold: msg.threshold };
  let count = 0;
  for (let i = 0; i < probs.length; i++) if (probs[i] >= msg.threshold) count++;
  post({ type: 'geo-ready', id: msg.id, count });
}

async function handleAnalyze(msg: Extract<WorkerRequest, { type: 'analyze' }>): Promise<void> {
  post({ type: 'stage', id: msg.id, stage: 'spectrogram' });
  const t0 = performance.now();
  post({ type: 'stage', id: msg.id, stage: 'network' });
  const probs = await runAcoustic(msg.audio);
  post({ type: 'stage', id: msg.id, stage: 'filter' });
  const scores = rankScores(probs, floor, geoMask);
  post({ type: 'result', id: msg.id, scores, inferMs: performance.now() - t0, geoApplied: geoMask !== null, tag: msg.tag });
}

async function handleAnalyzeFile(msg: Extract<WorkerRequest, { type: 'analyze-file' }>): Promise<void> {
  const plan = planWindows(msg.audio.length, WINDOW_SAMPLES, msg.hopSamples, SAMPLE_RATE);
  for (let i = 0; i < plan.length; i++) {
    if (cancelled.has(msg.id)) {
      cancelled.delete(msg.id);
      post({ type: 'file-done', id: msg.id, cancelled: true });
      return;
    }
    const w = extractWindow(msg.audio, plan[i].offsetSamples, WINDOW_SAMPLES);
    const probs = await runAcoustic(w);
    post({ type: 'file-window', id: msg.id, offsetSamples: plan[i].offsetSamples, padded: plan[i].padded, scores: rankScores(probs, floor, geoMask), index: i, total: plan.length });
    await yieldToEvents();
  }
  post({ type: 'file-done', id: msg.id, cancelled: false });
}

async function handleOcclusion(msg: Extract<WorkerRequest, { type: 'occlusion' }>): Promise<void> {
  const { timeSteps, freqBands, targetIndex } = msg;
  const audio = extractWindow(msg.audio, 0, WINDOW_SAMPLES);
  const total = timeSteps * freqBands + 1;
  const baseline = (await runAcoustic(audio))[targetIndex];
  post({ type: 'occlusion-progress', id: msg.id, done: 1, total });
  const s = analysisStft(audio);
  const bandEdgesHz = melBandEdges(freqBands, 15000);
  const map = new Float32Array(timeSteps * freqBands);
  let done = 1;
  for (let t = 0; t < timeSteps; t++) {
    for (let f = 0; f < freqBands; f++) {
      if (cancelled.has(msg.id)) {
        cancelled.delete(msg.id);
        post({ type: 'occlusion-done', id: msg.id, baseline, map, timeSteps, freqBands, bandEdgesHz, cancelled: true }, [map.buffer]);
        return;
      }
      const masked = occludeAudio(audio, s, regionFor(s, SAMPLE_RATE, t, timeSteps, bandEdgesHz, f));
      const p = (await runAcoustic(masked))[targetIndex];
      map[t * freqBands + f] = baseline - p;
      done++;
      post({ type: 'occlusion-progress', id: msg.id, done, total });
      await yieldToEvents();
    }
  }
  post({ type: 'occlusion-done', id: msg.id, baseline, map, timeSteps, freqBands, bandEdgesHz, cancelled: false }, [map.buffer]);
}

async function handle(msg: WorkerRequest): Promise<void> {
  switch (msg.type) {
    case 'init':
      return handleInit(msg);
    case 'set-geo':
      return handleSetGeo(msg);
    case 'analyze':
      return handleAnalyze(msg);
    case 'analyze-file':
      return handleAnalyzeFile(msg);
    case 'occlusion':
      return handleOcclusion(msg);
    case 'cancel':
      return;
  }
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  queue = queue
    .then(() => handle(msg))
    .catch((err: unknown) => {
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
    });
};
