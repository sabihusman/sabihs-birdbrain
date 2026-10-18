/**
 * Offline sanity check: load the BirdNET TF.js model in Node (CPU backend)
 * with our MelSpecLayerSimple implementation and run it on WAV files.
 *
 *   npx tsx scripts/validate-model.ts <modelDir> <mode: real|magnitude> <file.wav> [maxWindows]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tf from '@tensorflow/tfjs';
import { MelSpecLayerSimple, registerMelSpecLayer } from '../src/model/melspec-layer';
import { decodeWav, toMono } from '../src/audio/wav';
import { resampleLinear } from '../src/audio/resample';
import { WINDOW_SAMPLES, SAMPLE_RATE } from '../src/model/constants';

function fileHandler(modelJsonPath: string): tf.io.IOHandler {
  return {
    load: async () => {
      const dir = path.dirname(modelJsonPath);
      const json = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
      const manifest = json.weightsManifest as Array<{ paths: string[]; weights: tf.io.WeightsManifestEntry[] }>;
      const chunks: Buffer[] = [];
      for (const g of manifest) for (const p of g.paths) chunks.push(fs.readFileSync(path.join(dir, p)));
      const all = Buffer.concat(chunks);
      const weightData = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
      return {
        modelTopology: json.modelTopology,
        weightSpecs: manifest.flatMap((g) => g.weights),
        weightData,
        format: json.format,
        generatedBy: json.generatedBy,
        convertedBy: json.convertedBy,
        signature: json.signature,
      };
    },
  };
}

async function main() {
  const [modelDir, mode, wavPath, maxWindowsArg] = process.argv.slice(2);
  const maxWindows = Number(maxWindowsArg ?? 3);
  await tf.setBackend('cpu');
  await tf.ready();
  MelSpecLayerSimple.spectrumMode = mode === 'magnitude' ? 'magnitude' : 'real';
  registerMelSpecLayer();
  const labels = JSON.parse(fs.readFileSync(path.join(modelDir, 'labels.json'), 'utf8')) as string[];

  let t0 = Date.now();
  const model = await tf.loadLayersModel(fileHandler(path.join(modelDir, 'model.json')));
  console.log(`[${mode}] model loaded in ${Date.now() - t0} ms; inputs`, model.inputs.map((i) => i.shape), 'outputs', model.outputs.map((o) => o.shape));

  const wav = decodeWav(fs.readFileSync(wavPath).buffer as ArrayBuffer);
  let mono = toMono(wav.channels);
  if (wav.sampleRate !== SAMPLE_RATE) mono = resampleLinear(mono, wav.sampleRate, SAMPLE_RATE);
  console.log(`audio: ${wav.sampleRate} Hz, ${wav.channels.length} ch, ${wav.durationSec.toFixed(2)} s`);

  const windows = Math.min(maxWindows, Math.floor(mono.length / WINDOW_SAMPLES));
  for (let w = 0; w < windows; w++) {
    const chunk = mono.subarray(w * WINDOW_SAMPLES, (w + 1) * WINDOW_SAMPLES);
    t0 = Date.now();
    const input = tf.tensor2d(chunk, [1, WINDOW_SAMPLES]);
    const out = model.predict(input) as tf.Tensor;
    const probs = (await out.data()) as Float32Array;
    input.dispose();
    out.dispose();
    const top = Array.from(probs)
      .map((p, i) => [p, i] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 5)
      .map(([p, i]) => `${labels[i]}=${p.toFixed(3)}`);
    console.log(`  window ${w} (${w * 3}-${w * 3 + 3}s) in ${Date.now() - t0} ms: ${top.join(' | ')}`);
  }

  // Geo model
  const geo = await tf.loadGraphModel(fileHandler(path.join(modelDir, 'mdata', 'model.json')));
  console.log('geo model inputs', geo.inputs.map((i) => `${i.name} ${i.shape}`), 'outputs', geo.outputs.map((o) => `${o.name} ${o.shape}`));
  for (const [lat, lon, week] of [[42.44, -76.5, 20], [42.44, -76.5, -1], [52.5, 13.4, 42]]) {
    const g = geo.predict(tf.tensor2d([[lat, lon, week]])) as tf.Tensor;
    const p = (await g.data()) as Float32Array;
    g.dispose();
    const ranked = Array.from(p).map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
    const above = ranked.filter(([v]) => v >= 0.03).length;
    console.log(`  geo(${lat},${lon},wk ${week}): ${above} species >= 0.03; top: ${ranked.slice(0, 5).map(([v, i]) => `${labels[i].split('_')[1]}=${v.toFixed(2)}`).join(', ')}`);
  }
  console.log('tensors alive:', tf.memory().numTensors);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
