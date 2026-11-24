import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resample48to32 } from '../src/audio/resample-32k';
import { effectiveModel, canChooseModel } from '../src/app/access';
import { isModelCached } from '../src/app/first-visit';
import { DEFAULT_SETTINGS, migrate, sanitize } from '../src/app/settings';
import { lookupOnly, parseLabels, parseV3Labels } from '../src/model/labels';
import { geoToAudioOrder, ORT_VERSION, V3_AUDIO_BYTES, V3_CACHE_NAME, V3_GEO_BYTES, V3_ORT_WASM_BYTES, V3_ORT_WASM_FILE, v3BaseUrl } from '../src/model/v3';
import { BIRDNET_CREDIT, BIRDNET_V3_CREDIT } from '../src/ui/credits';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const user = (role: 'admin' | 'member', status: 'approved' | 'pending' = 'approved') => ({ id: 'u', email: 'u@example.com', name: 'U', role, status });

describe('BirdNET+ V3.0 for registered accounts (DECISIONS.md #133, #136)', () => {
  it('runs for approved and waiting accounts unless they chose V2.4; signed out or blocked gets V2.4', () => {
    expect(effectiveModel('v3.0', user('member'))).toBe('v3.0');
    expect(effectiveModel('v3.0', user('member', 'pending'))).toBe('v3.0');
    expect(effectiveModel('v3.0', user('admin'))).toBe('v3.0');
    expect(effectiveModel('v2.4', user('member'))).toBe('v2.4');
    expect(effectiveModel('v3.0', null)).toBe('v2.4');
    expect(effectiveModel('v3.0', { ...user('member'), status: 'disabled' } as never)).toBe('v2.4');
    expect(canChooseModel(user('member', 'pending'))).toBe(true);
    expect(canChooseModel(null)).toBe(false);
  });

  it('defaults to V3.0, keeps only the two known values, and moves a stored V2.4 to V3.0 once', () => {
    expect(DEFAULT_SETTINGS.birdnetModel).toBe('v3.0');
    expect(sanitize({ ...DEFAULT_SETTINGS, birdnetModel: 'v2.4' }).birdnetModel).toBe('v2.4');
    expect(sanitize({ ...DEFAULT_SETTINGS, birdnetModel: 'v9' as never }).birdnetModel).toBe('v3.0');
    // Saved before version 7, V2.4 was everyone's default (only the admin could choose, and chose V3.0).
    expect(migrate({ ...DEFAULT_SETTINGS, birdnetModel: 'v2.4', version: 6 }).birdnetModel).toBe('v3.0');
    // Chosen since: kept.
    expect(migrate({ ...DEFAULT_SETTINGS, birdnetModel: 'v2.4', version: 7 }).birdnetModel).toBe('v2.4');
  });

  it('finds the V3.0 folder next to the V2.4 one', () => {
    expect(v3BaseUrl('https://bird-brain.duckdns.org/models/birdnet-v2.4/')).toBe('https://bird-brain.duckdns.org/models/birdnet-v3.0/');
    expect(v3BaseUrl('/models/birdnet-v2.4/')).toBe('/models/birdnet-v3.0/');
    expect(v3BaseUrl('https://cdn.example.com/m/')).toBe('https://cdn.example.com/m/birdnet-v3.0/');
  });

  it('uses the ONNX Runtime engine file of the installed version, with the sizes the progress bar counts', () => {
    const pinned = JSON.parse(read('package.json')).dependencies['onnxruntime-web'];
    const installed = JSON.parse(read('node_modules/onnxruntime-web/package.json')).version;
    expect(pinned).toBe(ORT_VERSION);
    expect(installed).toBe(ORT_VERSION);
    expect(fs.statSync(path.join(root, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')).size).toBe(V3_ORT_WASM_BYTES);
    const sums = read('models/birdnet-v3.0/SHA256SUMS');
    for (const f of ['audio.onnx', 'geo.onnx', V3_ORT_WASM_FILE, 'MODEL_LICENSE.txt', 'ACCEPTABLE_USE.txt']) expect(sums, f).toContain(f);
    // The weights are not in git; when they have been fetched, their sizes match.
    const sizes: Array<[string, number]> = [
      ['models/birdnet-v3.0/audio.onnx', V3_AUDIO_BYTES],
      ['models/birdnet-v3.0/geo.onnx', V3_GEO_BYTES],
    ];
    for (const [f, n] of sizes) if (fs.existsSync(path.join(root, f))) expect(fs.statSync(path.join(root, f)).size, f).toBe(n);
  });

  it('reads labels.json: 11,725 classes, birds by taxon group, the location-model index per class', () => {
    const { species, geoIndex, soundClass } = parseV3Labels(JSON.parse(read('public/models/birdnet-v3.0/labels.json')));
    expect(species).toHaveLength(11_725);
    expect(species.filter((s) => s.isBird)).toHaveLength(9_788);
    const redpoll = species.find((s) => s.scientific === 'Acanthis flammea')!;
    expect(redpoll).toMatchObject({ common: 'Redpoll', isBird: true, group: 'Aves' });
    expect(geoIndex[redpoll.index]).toBe(10_462);
    // Frogs and insects are not birds; the 16 sound classes have no location score.
    expect(species.find((s) => s.group === 'Amphibia')?.isBird).toBe(false);
    expect(soundClass.reduce((n, v) => n + v, 0)).toBe(16);
    species.forEach((s, i) => {
      if (soundClass[i]) expect(geoIndex[i], s.scientific).toBe(-1);
    });
  });

  it('keeps V2.4 names V3.0 lacks for saved birds, never as something V3.0 can detect', () => {
    const v24 = parseLabels(['Accipiter cooperii_Cooper’s Hawk', 'Acanthis flammea_Common Redpoll']);
    const v3 = new Map([['Acanthis flammea', { index: 7, label: 'Acanthis flammea_Redpoll', scientific: 'Acanthis flammea', common: 'Redpoll', isBird: true }]]);
    expect(lookupOnly(v24, v3)).toEqual([{ index: -1, label: 'Accipiter cooperii_Cooper’s Hawk', scientific: 'Accipiter cooperii', common: 'Cooper’s Hawk', isBird: true }]);
  });

  it('lines the location model up with the audio classes: unknown species 0, sound classes 1', () => {
    const geoRow = Float32Array.from([0.1, 0.2, 0.3]);
    expect(Array.from(geoToAudioOrder(geoRow, Int32Array.from([2, -1, 0, -1]), Uint8Array.from([0, 0, 0, 1])))).toEqual([0.30000001192092896, 0, 0.10000000149011612, 1]);
  });

  it('checks its own cache bucket for a saved model', async () => {
    const cache = { has: async (n: string) => n === V3_CACHE_NAME, open: async () => ({ match: async (u: string) => (u === '/m/birdnet-v3.0/audio.onnx' ? new Response('') : undefined) }) };
    expect(await isModelCached(cache as never, '/m/birdnet-v3.0/', V3_CACHE_NAME, 'audio.onnx')).toBe(true);
    expect(await isModelCached(cache as never, '/m/birdnet-v2.4/')).toBe(false);
  });

  it('credits V3.0 under its own licence', () => {
    expect(BIRDNET_CREDIT.licenceText).toBe('CC BY-NC-SA 4.0');
    expect(BIRDNET_V3_CREDIT).toMatchObject({ linkText: 'BirdNET+ V3.0', licenceText: 'Apache 2.0' });
    expect(read('models/birdnet-v3.0/MODEL_LICENSE.txt')).toContain('Apache License 2.0');
  });
});

describe('48 → 32 kHz for V3.0', () => {
  const sine = (hz: number, n: number, rate = 48000) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
  const rms = (x: Float32Array, from = 200, to = x.length - 200) => Math.sqrt(x.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from));

  it('turns a 3 s window into exactly 96,000 samples', () => {
    expect(resample48to32(new Float32Array(144_000))).toHaveLength(96_000);
  });

  it('keeps a constant level and bird-range tones, and removes what would fold back above 16 kHz', () => {
    const dc = resample48to32(new Float32Array(4800).fill(0.5));
    expect(dc[1600]).toBeCloseTo(0.5, 4);
    for (const hz of [500, 4000, 12000]) expect(rms(resample48to32(sine(hz, 48000))), `${hz} Hz`).toBeCloseTo(Math.SQRT1_2, 2);
    // 20 kHz would alias to 12 kHz at 32 kHz: at least 40 dB down.
    expect(rms(resample48to32(sine(20000, 48000)))).toBeLessThan(Math.SQRT1_2 / 100);
  });

  it('keeps timing: a 1 kHz tone matches the same tone made at 32 kHz', () => {
    const out = resample48to32(sine(1000, 48000));
    const ref = sine(1000, 32000, 32000);
    const err = out.subarray(200, 31800).reduce((m, v, i) => Math.max(m, Math.abs(v - ref[i + 200])), 0);
    expect(err).toBeLessThan(0.01);
  });
});

describe('switching models starts a fresh worker', () => {
  it('ends the old worker, refuses what was waiting and goes back to "not loaded"', async () => {
    const { InferenceClient } = await import('../src/model/worker-client');
    const made: Array<{ terminated: boolean; sent: unknown[] }> = [];
    const factory = () => {
      const w = { terminated: false, sent: [] as unknown[], onmessage: null, onerror: null, postMessage(m: unknown) { this.sent.push(m); }, terminate() { this.terminated = true; } };
      made.push(w);
      return w as unknown as Worker;
    };
    const client = new InferenceClient(factory);
    const waiting = client.init('/m/birdnet-v3.0/', 'auto', 0.01, 'v3.0', { geoIndex: new Int32Array(1), soundClass: new Uint8Array(1) });
    expect(client.getStatus()).toMatchObject({ state: 'loading', model: 'v3.0' });
    expect(made[0].sent[0]).toMatchObject({ type: 'init', model: 'v3.0' });
    client.restart();
    await expect(waiting).rejects.toThrow('The model was switched');
    expect(made[0].terminated).toBe(true);
    expect(made).toHaveLength(2);
    expect(client.getStatus()).toMatchObject({ state: 'idle', model: null });
  });
});

describe('why a model load failed, for the admin (DECISIONS.md #135)', () => {
  it('keeps the error type and message, short', async () => {
    const { failureDetail } = await import('../src/app/controller');
    expect(failureDetail(new RangeError('Out of memory'))).toBe('RangeError: Out of memory');
    expect(failureDetail(new Error('https://x/models/birdnet-v3.0/audio.onnx 404'))).toBe('Error: https://x/models/birdnet-v3.0/audio.onnx 404');
    expect(failureDetail(new Error('x'.repeat(500)))).toHaveLength(200);
  });
});
