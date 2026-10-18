/** BirdNET V2.4 constants (see docs/SOURCES.md). */
export const SAMPLE_RATE = 48000;
export const WINDOW_SECONDS = 3;
export const WINDOW_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS; // 144000
export const NUM_CLASSES = 6522;
/** Default overlap between consecutive analysis windows, in seconds. */
export const DEFAULT_OVERLAP_SECONDS = 1.5;
/** BirdNET-Analyzer's default location-filter threshold on the geo model output. */
export const GEO_FILTER_THRESHOLD = 0.03;
/** Model files, relative to the app base URL. */
export const MODEL_DIR = 'models/birdnet-v2.4/';
export const ACOUSTIC_MODEL_JSON = `${MODEL_DIR}model.json`;
export const GEO_MODEL_JSON = `${MODEL_DIR}mdata/model.json`;
export const LABELS_JSON = `${MODEL_DIR}labels.json`;
/** Exact byte size of the model files served from MODEL_DIR (for the download progress bar). */
export const ACOUSTIC_MODEL_BYTES = 52_215_312;
export const GEO_MODEL_BYTES = 29_546_297;
export const MODEL_TOTAL_BYTES = ACOUSTIC_MODEL_BYTES + GEO_MODEL_BYTES;
/** Shortest trailing segment of a recording that is still analysed (zero-padded), in samples. */
export const MIN_SEGMENT_SAMPLES = SAMPLE_RATE;
/** Cache API bucket shared by the worker's model loader and the service worker runtime route. */
export const MODEL_CACHE_NAME = 'birdnet-models-v2.4';
