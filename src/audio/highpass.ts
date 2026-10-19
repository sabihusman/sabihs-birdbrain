/**
 * Low-cut (high-pass) filter for the analysis path. Wind rumble, handling
 * noise and traffic sit below ~150 Hz; almost no bird sound does. The live
 * path uses a BiquadFilterNode; imported and re-analysed clips are rendered
 * through the same node type in an OfflineAudioContext, with a plain-JS
 * biquad (identical formula) as the fallback where Web Audio is unavailable.
 * Saved recordings are never filtered.
 */

export const LOW_CUT_HZ = 150;
/** BiquadFilterNode's Q for highpass is in dB (Web Audio API §BiquadFilterNode); 1 dB is the node default. */
export const LOW_CUT_Q_DB = 1;

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** High-pass coefficients as the Web Audio API specifies them (Q in dB), normalised by a0. */
export function highpassCoefficients(cutoffHz: number, sampleRate: number, qDb = LOW_CUT_Q_DB): BiquadCoefficients {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
  const a0 = 1 + alpha;
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Apply the high-pass filter to a copy of the samples (direct form I). */
export function applyHighpass(samples: Float32Array, sampleRate: number, cutoffHz = LOW_CUT_HZ, qDb = LOW_CUT_Q_DB): Float32Array {
  const { b0, b1, b2, a1, a2 } = highpassCoefficients(cutoffHz, sampleRate, qDb);
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** Parameters applied to the live BiquadFilterNode. */
export const LOW_CUT_NODE_PARAMS = { type: 'highpass' as const, frequency: LOW_CUT_HZ, Q: LOW_CUT_Q_DB };

/** Structural view of BiquadFilterNode so this compiles under both the DOM and WebWorker libs. */
export interface LowCutNode {
  type: string;
  frequency: { value: number };
  Q: { value: number };
}

export function configureLowCut(node: LowCutNode): void {
  node.type = LOW_CUT_NODE_PARAMS.type;
  node.frequency.value = LOW_CUT_NODE_PARAMS.frequency;
  node.Q.value = LOW_CUT_NODE_PARAMS.Q;
}

// Minimal structural types for the Web Audio objects used below (WebWorker lib has none).
interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}
interface AudioNodeLike {
  connect(dest: AudioNodeLike): unknown;
}
interface OfflineAudioContextLike {
  destination: AudioNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioNodeLike & { buffer: AudioBufferLike | null; start(): void };
  createBiquadFilter(): AudioNodeLike & LowCutNode;
  startRendering(): Promise<AudioBufferLike>;
}
type OfflineAudioContextCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContextLike;

/**
 * Filter a whole clip for analysis. Uses OfflineAudioContext + BiquadFilterNode
 * when available (browsers), otherwise the JS biquad (tests, workers).
 */
export async function renderLowCut(audio: Float32Array, sampleRate: number): Promise<Float32Array> {
  const OAC = (globalThis as { OfflineAudioContext?: OfflineAudioContextCtor }).OfflineAudioContext;
  if (!OAC || audio.length === 0) return applyHighpass(audio, sampleRate);
  try {
    const ctx = new OAC(1, audio.length, sampleRate);
    const buffer = ctx.createBuffer(1, audio.length, sampleRate);
    buffer.getChannelData(0).set(audio);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    configureLowCut(filter);
    src.connect(filter);
    filter.connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0).slice();
  } catch {
    return applyHighpass(audio, sampleRate);
  }
}
