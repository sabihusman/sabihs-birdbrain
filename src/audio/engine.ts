import { Emitter } from '../shared/emitter';
import { SAMPLE_RATE, WINDOW_SAMPLES } from '../model/constants';
import { StreamingResampler } from './resample';
import { Windower } from './windowing';

export type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported';

export interface EngineEvents extends Record<string, unknown> {
  /** Mono audio at 48 kHz as it arrives. */
  chunk: Float32Array;
  /** A complete analysis window. */
  window: { audio: Float32Array; offsetSamples: number };
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

/**
 * Microphone -> AudioWorklet -> mono 48 kHz chunks -> overlapping windows.
 * start() must be called from a user gesture (iOS requirement).
 */
export class AudioEngine extends Emitter<EngineEvents> {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private resampler: StreamingResampler | null = null;
  private windower: Windower;
  private state: EngineState = 'stopped';
  private samplesSeen = 0;
  private hopSamples: number;

  constructor(
    private workletUrl: string,
    overlapSeconds: number,
  ) {
    super();
    this.hopSamples = AudioEngine.hopFor(overlapSeconds);
    this.windower = new Windower(WINDOW_SAMPLES, this.hopSamples);
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      await ctx.audioWorklet.addModule(this.workletUrl);
      this.source = ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { batchSize: 2048 } });
      // Keep the graph alive without producing sound.
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
      this.resampler = ctx.sampleRate === SAMPLE_RATE ? null : new StreamingResampler(ctx.sampleRate, SAMPLE_RATE);
      this.windower.reset();
      this.samplesSeen = 0;
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk(e.data);
      this.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
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

  private onChunk(raw: Float32Array): void {
    if (this.state !== 'running') return;
    const chunk = this.resampler ? this.resampler.process(raw) : raw;
    this.samplesSeen += chunk.length;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    this.emit('level', Math.sqrt(sum / Math.max(1, chunk.length)));
    this.emit('chunk', chunk);
    for (const w of this.windower.push(chunk)) this.emit('window', { audio: w.window, offsetSamples: w.offsetSamples });
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
    this.node?.port.postMessage('stop');
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const ctx = this.ctx;
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    this.resampler = null;
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
