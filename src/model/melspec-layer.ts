import * as tf from '@tensorflow/tfjs';
import { FFT, hannWindow } from '../audio/fft';
import { frameCount } from '../audio/stft';

/**
 * Re-implementation of BirdNET V2.4's custom Keras front end layer
 * "MelSpecLayerSimple", which turns raw 48 kHz audio into a mel spectrogram
 * inside the network. The layer's parameters (frame length, hop, mel
 * filterbank, learned magnitude scaling) all come from model.json; this file
 * only provides the computation.
 *
 * The STFT is computed here in plain JavaScript rather than with
 * tf.signal.stft so the layer works on every TF.js backend (the WASM backend
 * has no FFT kernels) and so the exact same FFT drives the on-screen
 * spectrogram.
 */

export type SpectrumMode = 'real' | 'magnitude';

export interface MelSpecLayerConfig {
  sampleRate: number;
  specShape: [number, number];
  frameStep: number;
  frameLength: number;
  fmin: number;
  fmax: number;
  melFilterbank: number[][];
  name?: string;
  trainable?: boolean;
  dtype?: tf.DataType;
}

/**
 * Normalise a window of audio to [-1, 1] the way the model expects:
 * subtract the minimum, divide by the (shifted) maximum, centre and scale.
 */
export function normalizeWindow(samples: ArrayLike<number>): Float64Array {
  const n = samples.length;
  let min = Infinity;
  for (let i = 0; i < n; i++) if (samples[i] < min) min = samples[i];
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = samples[i] - min;
    if (v > max) max = v;
  }
  const denom = max + 0.000001;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (((samples[i] - min) / denom) - 0.5) * 2;
  return out;
}

export class MelSpecLayerSimple extends tf.layers.Layer {
  static className = 'MelSpecLayerSimple';
  /** How the complex STFT is reduced to a real value before the mel filterbank. */
  static spectrumMode: SpectrumMode = 'real';

  readonly sampleRate: number;
  readonly specShape: [number, number];
  readonly frameStep: number;
  readonly frameLength: number;
  readonly fmin: number;
  readonly fmax: number;
  private readonly melFilterbankData: number[][];
  private readonly melFilterbank: tf.Tensor2D;
  private readonly window: Float64Array;
  private readonly fft: FFT;
  private magScale!: tf.LayerVariable;

  constructor(config: MelSpecLayerConfig) {
    super({ name: config.name, trainable: config.trainable, dtype: config.dtype });
    this.sampleRate = config.sampleRate;
    this.specShape = config.specShape;
    this.frameStep = config.frameStep;
    this.frameLength = config.frameLength;
    this.fmin = config.fmin;
    this.fmax = config.fmax;
    this.melFilterbankData = config.melFilterbank;
    this.melFilterbank = tf.keep(tf.tensor2d(config.melFilterbank));
    this.window = hannWindow(this.frameLength);
    this.fft = new FFT(this.frameLength);
  }

  override build(inputShape: tf.Shape | tf.Shape[]): void {
    this.magScale = this.addWeight('magnitude_scaling', [], 'float32', tf.initializers.constant({ value: 1.23 }));
    super.build(inputShape);
  }

  override computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape {
    const shape = (Array.isArray(inputShape[0]) ? inputShape[0] : inputShape) as tf.Shape;
    const length = shape[1] ?? this.sampleRate * 3;
    return [shape[0], this.specShape[0], frameCount(length, this.frameLength, this.frameStep), 1];
  }

  /**
   * Linear spectrum for one normalised window, row-major [frame][bin], using
   * either the real part of the STFT (what the official TF.js demo computes
   * via tf.cast(complex, 'float32')) or its magnitude.
   */
  linearSpectrum(samples: ArrayLike<number>, mode: SpectrumMode = MelSpecLayerSimple.spectrumMode): Float32Array {
    const normalised = normalizeWindow(samples);
    const frames = frameCount(normalised.length, this.frameLength, this.frameStep);
    const bins = this.frameLength / 2 + 1;
    const out = new Float32Array(frames * bins);
    const re = new Float64Array(this.frameLength);
    const im = new Float64Array(this.frameLength);
    for (let f = 0; f < frames; f++) {
      const start = f * this.frameStep;
      for (let i = 0; i < this.frameLength; i++) {
        re[i] = normalised[start + i] * this.window[i];
        im[i] = 0;
      }
      this.fft.forward(re, im);
      const o = f * bins;
      if (mode === 'real') {
        for (let k = 0; k < bins; k++) out[o + k] = re[k];
      } else {
        for (let k = 0; k < bins; k++) out[o + k] = Math.hypot(re[k], im[k]);
      }
    }
    return out;
  }

  override call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor {
    return tf.tidy(() => {
      const x = Array.isArray(inputs) ? inputs[0] : inputs;
      const [batch, length] = x.shape as [number, number];
      const data = x.dataSync() as Float32Array;
      const frames = frameCount(length, this.frameLength, this.frameStep);
      const bins = this.frameLength / 2 + 1;
      const exponent = tf.div(1, tf.add(1, tf.exp(this.magScale.read())));
      const specs: tf.Tensor[] = [];
      for (let b = 0; b < batch; b++) {
        const spectrum = this.linearSpectrum(data.subarray(b * length, (b + 1) * length));
        let spec: tf.Tensor = tf.tensor2d(spectrum, [frames, bins]);
        spec = tf.matMul(spec, this.melFilterbank); // [frames, mel]
        spec = tf.square(spec); // power
        spec = tf.pow(spec, exponent); // learned non-linear magnitude scaling
        spec = tf.reverse(spec, -1); // highest mel band first
        spec = tf.transpose(spec); // [mel, frames]
        specs.push(tf.expandDims(spec, -1));
      }
      return tf.stack(specs);
    });
  }

  override getConfig(): tf.serialization.ConfigDict {
    const base = super.getConfig();
    return {
      ...base,
      sampleRate: this.sampleRate,
      specShape: this.specShape,
      frameStep: this.frameStep,
      frameLength: this.frameLength,
      fmin: this.fmin,
      fmax: this.fmax,
      melFilterbank: this.melFilterbankData,
    };
  }

  override dispose() {
    this.melFilterbank.dispose();
    return super.dispose();
  }
}

let registered = false;
/** Register the custom layer with TF.js so loadLayersModel can deserialise it. Idempotent. */
export function registerMelSpecLayer(): void {
  if (registered) return;
  tf.serialization.registerClass(MelSpecLayerSimple);
  registered = true;
}
