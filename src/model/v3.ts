/**
 * BirdNET+ V3.0, the admin-only test model (DECISIONS.md #133). Everything here is specific to V3.0; the V2.4
 * constants in constants.ts stay as they are, and the app keeps feeding the worker 3-second windows at 48 kHz.
 *
 * Source: Zenodo record 24362980 (version 3.0.1). The weights are Apache 2.0 (models/birdnet-v3.0/MODEL_LICENSE.txt).
 */
import { MODEL_BASE_URL, MODEL_VERSION } from './model-source';

/** Which model identifies birds: V2.4 for everyone, V3.0 for the admin while it is tested. */
export type ModelId = 'v2.4' | 'v3.0';
export const MODEL_IDS: readonly ModelId[] = ['v2.4', 'v3.0'];

/** Plain names, for Settings, the Listen card and the credit line. */
export const MODEL_NAMES: Record<ModelId, string> = { 'v2.4': 'BirdNET V2.4', 'v3.0': 'BirdNET+ V3.0' };

export const V3_FOLDER = 'birdnet-v3.0';
/** V3.0 listens at 32 kHz; the worker converts each 48 kHz window (resample.ts). */
export const V3_SAMPLE_RATE = 32000;
export const V3_WINDOW_SAMPLES = V3_SAMPLE_RATE * 3; // 96000

/** The full 12K model (11,725 classes), mixed precision. */
export const V3_AUDIO_FILE = 'audio.onnx';
export const V3_GEO_FILE = 'geo.onnx';
/**
 * The ONNX Runtime Web engine, served next to the model so the front end on Vercel stays small. Its JavaScript half
 * is bundled from the `onnxruntime-web` package, so the two must be the same version: tests/v3-model.test.ts checks
 * this against package.json.
 */
export const ORT_VERSION = '1.31.1';
export const V3_ORT_WASM_FILE = `ort-wasm-simd-threaded-${ORT_VERSION}.wasm`;

export const V3_AUDIO_BYTES = 173_871_766;
export const V3_GEO_BYTES = 7_729_898;
export const V3_ORT_WASM_BYTES = 14_848_852;
export const V3_TOTAL_BYTES = V3_AUDIO_BYTES + V3_GEO_BYTES + V3_ORT_WASM_BYTES;

/** Its own Cache API bucket, so switching models never deletes the other one's files. */
export const V3_CACHE_NAME = 'birdnet-models-v3.0';
/** The species list (674 KiB), from the app itself; made by scripts/prepare-labels-v3.mts. Not precached. */
export const V3_LABELS_JSON = `models/${V3_FOLDER}/labels.json`;

/**
 * The V3.0 folder sits next to the V2.4 one on the same host (`…/models/birdnet-v2.4/` → `…/models/birdnet-v3.0/`).
 * A base URL that does not end in the V2.4 folder gets the V3.0 folder added below it.
 */
export function v3BaseUrl(v24BaseUrl: string): string {
  const suffix = `${MODEL_VERSION}/`;
  return v24BaseUrl.endsWith(suffix) ? `${v24BaseUrl.slice(0, -suffix.length)}${V3_FOLDER}/` : `${v24BaseUrl}${V3_FOLDER}/`;
}

export const V3_BASE_URL = v3BaseUrl(MODEL_BASE_URL);

/** One row of labels.json: scientific name, English name, taxon group (Aves, Insecta, …), location-model output or -1. */
export type V3LabelRow = readonly [scientific: string, common: string, group: string, geoIndex: number];

export interface V3Labels {
  classes: V3LabelRow[];
}

/** Classes the location model says nothing about: the 16 sound classes (gun, siren, music, …). */
export const V3_SOUND_GROUPS: ReadonlySet<string> = new Set(['Anthropogenic', 'Geophony', 'Music']);

/**
 * The location model's output (one row of 14,057) rearranged into the audio model's class order (11,725), so the
 * rest of the app reads one index for both. A sound class has no location score and is never held back (1); a
 * species the location model does not know is treated as not expected anywhere (0), which is what BirdNET Live
 * does by leaving such species out of its model.
 */
export function geoToAudioOrder(geoRow: ArrayLike<number>, geoIndex: ArrayLike<number>, soundClass: ArrayLike<number>): Float32Array {
  const out = new Float32Array(geoIndex.length);
  for (let i = 0; i < geoIndex.length; i++) {
    const g = geoIndex[i];
    out[i] = g >= 0 ? geoRow[g] : soundClass[i] ? 1 : 0;
  }
  return out;
}
