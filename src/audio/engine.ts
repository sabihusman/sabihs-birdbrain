import { Emitter } from '../shared/emitter';
import { SAMPLE_RATE, WINDOW_SAMPLES } from '../model/constants';
import { configureLowCut } from './highpass';
import { classifyVoiceProcessing, MIC_AUDIO_CONSTRAINTS, type VoiceProcessingReport } from './mic-constraints';
import { StreamingResampler } from './resample';
import { SampleRing } from './ring-buffer';
import { Windower } from './windowing';

export type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported';

export interface EngineEvents extends Record<string, unknown> {
  /** Raw (unfiltered) mono audio at 48 kHz as it arrives. */
  chunk: Float32Array;
  /**
   * A complete analysis window. `audio` is the analysis path (low-cut filtered
   * when enabled); `raw` is the same span of unfiltered audio for saving, or
   * null if it is no longer in the raw ring.
   */
  window: { audio: Float32Array; raw: Float32Array | null; offsetSamples: number };
  /** What the browser applied to our "all voice processing off" request. */
  mic: VoiceProcessingReport;
  /** RMS level of the latest chunk, 0..1. */
  level: number;
  state: EngineState;
  error: string;
}

export type EngineState = 'stopped' | 'starting' | 'running' | 'suspended';

export interface StartError {
  kind: 'denied' | 'no-mic' | 'insecure' | 'unsupported' | 'busy' | 'other';
  message: string;
}

export function describeMicError(err: unknown): StartError {
  const e = err as { name?: string; message?: string };
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return { kind: 'insecure', message: 'Microphone access needs HTTPS (or localhost).' };
  }
  switch (e?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { kind: 'denied', message: 'Microphone access was denied. On iPhone: Settings › Safari › Microphone, or tap “aA” in the address bar › Website Settings. Home-screen apps ask again on their own.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { kind: 'no-mic', message: 'No microphone was found on this device.' };
    case 'NotReadableError':
    case 'AbortError':
      return { kind: 'busy', message: 'The microphone is in use by another app. Close it and try again.' };
    default:
      return { kind: 'other', message: e?.message ? `Could not start the microphone: ${e.message}` : 'Could not start the microphone.' };
  }
}

/** Best-effort microphone permission state (Safari does not implement the query). */
export async function queryMicPermission(): Promise<MicPermission> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unsupported';
  try {
    const perms = navigator.permissions;
    if (!perms?.query) return 'unknown';
    const status = await perms.query({ name: 'microphone' as PermissionName });
    return status.state as MicPermission;
  } catch {
    return 'unknown';
  }
}

/** Seconds of raw audio kept so a window analysed from the filtered path can be saved unfiltered. */
const RAW_RING_SECONDS = 8;

/**
 * Microphone -> two AudioWorklet taps -> mono 48 kHz chunks -> overlapping windows.
 *
 *   source ─────────────────► raw tap      → 'chunk' / 'level' (recording, visualisation, conditions)
 *   source ─► BiquadFilter ─► analysis tap → Windower → 'window' (inference)
 *
 * The analysis tap reads through a 150 Hz high-pass BiquadFilterNode when the
 * low-cut setting is on, or straight from the source when it is off. Saved
 * audio always comes from the raw tap. start() must be called from a user
 * gesture (iOS requirement).
 */
export class AudioEngine extends Emitter<EngineEvents> {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rawNode: AudioWorkletNode | null = null;
  private analysisNode: AudioWorkletNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private analysisInput: AudioNode | null = null;
  private sink: GainNode | null = null;
  private rawResampler: StreamingResampler | null = null;
  private analysisResampler: StreamingResampler | null = null;
  private readonly rawRing = new SampleRing(SAMPLE_RATE * RAW_RING_SECONDS);
  private pendingWindows: Array<{ audio: Float32Array; offsetSamples: number }> = [];
  private windower: Windower;
  private state: EngineState = 'stopped';
  private samplesSeen = 0;
  private hopSamples: number;
  private lowCut: boolean;
  private micReport: VoiceProcessingReport = classifyVoiceProcessing(null);

  constructor(
    private workletUrl: string,
    overlapSeconds: number,
    lowCut = true,
  ) {
    super();
    this.hopSamples = AudioEngine.hopFor(overlapSeconds);
    this.windower = new Windower(WINDOW_SAMPLES, this.hopSamples);
    this.lowCut = lowCut;
  }

  /** The last report from MediaStreamTrack.getSettings(); 'unknown' before the first session. */
  getMicReport(): VoiceProcessingReport {
    return this.micReport;
  }

  get lowCutEnabled(): boolean {
    return this.lowCut;
  }

  /** Switch the 150 Hz low-cut on the analysis path; takes effect immediately while running. */
  setLowCut(on: boolean): void {
    if (on === this.lowCut) return;
    this.lowCut = on;
    this.wireAnalysisInput();
  }

  private wireAnalysisInput(): void {
    const { source, filter, analysisNode } = this;
    if (!source || !filter || !analysisNode) return;
    const next: AudioNode = this.lowCut ? filter : source;
    if (this.analysisInput === next) return;
    try {
      this.analysisInput?.disconnect(analysisNode);
    } catch {
      /* not connected */
    }
    next.connect(analysisNode);
    this.analysisInput = next;
  }

  static hopFor(overlapSeconds: number): number {
    const hop = Math.round((3 - Math.min(2.5, Math.max(0, overlapSeconds))) * SAMPLE_RATE);
    return Math.max(SAMPLE_RATE / 2, Math.min(WINDOW_SAMPLES, hop));
  }

  getState(): EngineState {
    return this.state;
  }

  get contextSampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  /** Seconds of audio captured so far. */
  get capturedSeconds(): number {
    return this.samplesSeen / SAMPLE_RATE;
  }

  setOverlap(overlapSeconds: number): void {
    const hop = AudioEngine.hopFor(overlapSeconds);
    if (hop === this.hopSamples) return;
    this.hopSamples = hop;
    this.windower = new Windower(WINDOW_SAMPLES, hop);
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.emit('state', s);
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    this.setState('starting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('getUserMedia unsupported'), { name: 'UnsupportedError' });
      // Create the context inside the gesture, before any await, so iOS lets it start.
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      let ctx: AudioContext;
      try {
        ctx = new AC({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      } catch {
        ctx = new AC();
      }
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_AUDIO_CONSTRAINTS }, video: false });
      const track = this.stream.getAudioTracks()[0];
      // Constraints are "ideal", not required: read back what the browser actually applied.
      let applied: MediaTrackSettings | null = null;
      try {
        applied = typeof track?.getSettings === 'function' ? track.getSettings() : null;
      } catch {
        applied = null;
      }
      this.micReport = classifyVoiceProcessing(applied ?? {});
      this.emit('mic', this.micReport);
      await ctx.audioWorklet.addModule(this.workletUrl);
      this.source = ctx.createMediaStreamSource(this.stream);
      const tap = () => new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { batchSize: 2048 } });
      this.rawNode = tap();
      this.analysisNode = tap();
      this.filter = ctx.createBiquadFilter();
      configureLowCut(this.filter);
      // Keep the graph alive without producing sound.
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.rawNode);
      this.source.connect(this.filter);
      this.analysisInput = null;
      this.wireAnalysisInput();
      this.rawNode.connect(this.sink);
      this.analysisNode.connect(this.sink);
      this.sink.connect(ctx.destination);
      const needsResample = ctx.sampleRate !== SAMPLE_RATE;
      this.rawResampler = needsResample ? new StreamingResampler(ctx.sampleRate, SAMPLE_RATE) : null;
      this.analysisResampler = needsResample ? new StreamingResampler(ctx.sampleRate, SAMPLE_RATE) : null;
      this.windower.reset();
      this.rawRing.reset();
      this.pendingWindows = [];
      this.samplesSeen = 0;
      this.rawNode.port.onmessage = (e: MessageEvent<Float32Array>) => this.onRawChunk(e.data);
      this.analysisNode.port.onmessage = (e: MessageEvent<Float32Array>) => this.onAnalysisChunk(e.data);
      track?.addEventListener('ended', () => {
        this.emit('error', 'The microphone was disconnected.');
        void this.stop();
      });
      this.setState('running');
    } catch (err) {
      await this.teardown();
      this.setState('stopped');
      throw err;
    }
  }

  private onRawChunk(input: Float32Array): void {
    if (this.state !== 'running') return;
    const chunk = this.rawResampler ? this.rawResampler.process(input) : input;
    this.samplesSeen += chunk.length;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    this.emit('level', Math.sqrt(sum / Math.max(1, chunk.length)));
    this.rawRing.push(chunk);
    this.emit('chunk', chunk);
    this.flushPendingWindows();
  }

  private onAnalysisChunk(input: Float32Array): void {
    if (this.state !== 'running') return;
    const chunk = this.analysisResampler ? this.analysisResampler.process(input) : input;
    for (const w of this.windower.push(chunk)) this.pendingWindows.push({ audio: w.window, offsetSamples: w.offsetSamples });
    this.flushPendingWindows();
  }

  /**
   * Both taps run in the same render quanta, but their messages may arrive in
   * either order, so a window waits until the raw ring has caught up with it.
   */
  private flushPendingWindows(): void {
    while (this.pendingWindows.length) {
      const w = this.pendingWindows[0];
      const end = w.offsetSamples + w.audio.length;
      if (end > this.rawRing.end) return; // raw tap has not delivered these samples yet
      this.pendingWindows.shift();
      this.emit('window', { audio: w.audio, raw: this.rawRing.slice(w.offsetSamples, w.audio.length), offsetSamples: w.offsetSamples });
    }
  }

  /** Resume the AudioContext after the app returns to the foreground. */
  async resume(): Promise<void> {
    if (!this.ctx || this.state === 'stopped') return;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* needs a gesture */
      }
    }
    this.setState(this.ctx.state === 'running' ? 'running' : 'suspended');
  }

  private async teardown(): Promise<void> {
    for (const n of [this.rawNode, this.analysisNode]) {
      n?.port.postMessage('stop');
      n?.disconnect();
    }
    this.filter?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const ctx = this.ctx;
    this.rawNode = null;
    this.analysisNode = null;
    this.filter = null;
    this.analysisInput = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    this.rawResampler = null;
    this.analysisResampler = null;
    this.pendingWindows = [];
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    await this.teardown();
    this.setState('stopped');
  }
}
