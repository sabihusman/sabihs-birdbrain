import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_BASE_URL, MODEL_DOWNLOAD_ERROR, MODEL_VERSION, resolveModelBaseUrl } from '../src/model/model-source';
import { ACOUSTIC_MODEL_FILE, GEO_MODEL_FILE, LABELS_JSON, MODEL_TOTAL_BYTES } from '../src/model/constants';

describe('model source (DECISIONS.md #56)', () => {
  it('uses the API host for a production build', () => {
    expect(resolveModelBaseUrl({})).toBe('https://bird-brain.duckdns.org/models/birdnet-v2.4/');
    expect(DEFAULT_MODEL_BASE_URL).toContain(MODEL_VERSION);
  });

  it('serves the model from the app itself in development', () => {
    expect(resolveModelBaseUrl({ DEV: true, BASE_URL: '/' })).toBe('/models/birdnet-v2.4/');
    expect(resolveModelBaseUrl({ DEV: true, BASE_URL: '/sabihs-birdbrain/' })).toBe('/sabihs-birdbrain/models/birdnet-v2.4/');
  });

  it('prefers VITE_MODEL_BASE_URL and always ends with one slash', () => {
    expect(resolveModelBaseUrl({ VITE_MODEL_BASE_URL: 'https://cdn.example.com/m/v1' })).toBe('https://cdn.example.com/m/v1/');
    expect(resolveModelBaseUrl({ VITE_MODEL_BASE_URL: 'https://cdn.example.com/m/v1///' })).toBe('https://cdn.example.com/m/v1/');
    expect(resolveModelBaseUrl({ VITE_MODEL_BASE_URL: '  /models/x/  ', DEV: true })).toBe('/models/x/');
    // An empty or blank setting is ignored, not turned into "/".
    expect(resolveModelBaseUrl({ VITE_MODEL_BASE_URL: '   ' })).toBe(DEFAULT_MODEL_BASE_URL);
  });

  it('builds the two model URLs the worker loads', () => {
    const base = resolveModelBaseUrl({});
    expect(base + ACOUSTIC_MODEL_FILE).toBe('https://bird-brain.duckdns.org/models/birdnet-v2.4/model.json');
    expect(base + GEO_MODEL_FILE).toBe('https://bird-brain.duckdns.org/models/birdnet-v2.4/mdata/model.json');
  });

  it('keeps the species list on the app origin, so the offline list still works', () => {
    expect(LABELS_JSON).toBe('models/birdnet-v2.4/labels.json');
    expect(LABELS_JSON.startsWith('http')).toBe(false);
  });

  it('expects the published model to be the size the progress bar assumes', () => {
    // models/birdnet-v2.4/SHA256SUMS lists these files; publish-model.sh checks the hashes.
    expect(MODEL_TOTAL_BYTES).toBe(81_761_609);
  });

  it('tells the member what to do when the download fails', () => {
    expect(MODEL_DOWNLOAD_ERROR).toBe("Couldn't download the bird model. Check your connection and try again.");
  });
});
