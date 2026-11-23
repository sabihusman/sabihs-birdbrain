/**
 * BirdNET+ V3.0 inside the inference worker (DECISIONS.md #133), through ONNX Runtime Web on WebAssembly. Only the
 * worker imports this file, and only the admin's choice of V3.0 runs it.
 *
 * - CPU (WebAssembly) only, one thread: the site is not cross-origin isolated, so WebAssembly threads are not
 *   available; the GPU route (WebGPU) is left out until the CPU route is proven on an iPhone.
 * - The engine's .wasm file comes from the model host with the model (src/model/v3.ts) and is handed to ONNX Runtime
 *   as bytes, so it goes through the same cache and progress bar as the weights.
 * - Input windows arrive at 48 kHz like V2.4's; they are converted to 32 kHz here.
 */
import * as ort from 'onnxruntime-web/wasm';
import { resample48to32 } from '../audio/resample-32k';
import { geoToAudioOrder, V3_WINDOW_SAMPLES } from './v3';

export interface V3Maps {
  /** Location-model output index per audio class, -1 when it has none. */
  geoIndex: Int32Array;
  /** 1 for the sound classes (gun, siren, music, …). */
  soundClass: Uint8Array;
}

export class V3Runner {
  private constructor(
    private readonly audio: ort.InferenceSession,
    private readonly geo: ort.InferenceSession,
    private readonly maps: V3Maps,
  ) {}

  /** `wasm`, `audioModel`, `geoModel` are the downloaded files; the buffers can be dropped once this resolves. */
  static async create(files: { wasm: ArrayBuffer; audioModel: ArrayBuffer; geoModel: ArrayBuffer }, maps: V3Maps): Promise<V3Runner> {
    ort.env.wasm.wasmBinary = files.wasm;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const audio = await ort.InferenceSession.create(new Uint8Array(files.audioModel), options);
    const geo = await ort.InferenceSession.create(new Uint8Array(files.geoModel), options);
    return new V3Runner(audio, geo, maps);
  }

  get classCount(): number {
    return this.maps.geoIndex.length;
  }

  /** One 3-second window at 48 kHz → one probability per class (the sigmoid is part of the model). */
  async acoustic(window48k: Float32Array): Promise<Float32Array> {
    const x = resample48to32(window48k);
    const input = x.length === V3_WINDOW_SAMPLES ? x : fit(x, V3_WINDOW_SAMPLES);
    const out = await this.audio.run({ input: new ort.Tensor('float32', input, [1, V3_WINDOW_SAMPLES]) });
    const predictions = out.predictions.data as Float32Array;
    out.embeddings?.dispose();
    return predictions;
  }

  /** Location-model scores for rows of [lat, lon, week 1–48], each rearranged into the audio model's class order. */
  async geoRows(rows: ReadonlyArray<readonly [number, number, number]>): Promise<Float32Array[]> {
    const flat = new Float32Array(rows.length * 3);
    rows.forEach((r, i) => flat.set(r, i * 3));
    const out = await this.geo.run({ input: new ort.Tensor('float32', flat, [rows.length, 3]) });
    const probs = out.probabilities.data as Float32Array;
    const per = probs.length / rows.length;
    return rows.map((_, i) => geoToAudioOrder(probs.subarray(i * per, (i + 1) * per), this.maps.geoIndex, this.maps.soundClass));
  }
}

/** Zero-pad or cut to exactly `n` samples (a 3 s window at 48 kHz becomes exactly 96,000; this is a safety net). */
function fit(x: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out.set(x.subarray(0, n));
  return out;
}
