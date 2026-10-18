import { AudioEngine, describeMicError, type EngineState } from '../audio/engine';
import { Recorder } from '../audio/recorder';
import { decodeWav, encodeWav, toMono } from '../audio/wav';
import { resampleLinear } from '../audio/resample';
import { LABELS_JSON, SAMPLE_RATE, WINDOW_SAMPLES, WINDOW_SECONDS } from '../model/constants';
import { parseLabels, type Species } from '../model/labels';
import { selectDetections, type Score } from '../model/postprocess';
import { InferenceClient, type ModelStatus } from '../model/worker-client';
import { Emitter } from '../shared/emitter';
import { addDetections, newId, putRecording } from '../storage/db';
import type { DetectionRecord, RecordingRecord, SpeciesSummary } from '../storage/types';
import { LocationManager, type LocationState } from './location';
import { SettingsStore, type Settings } from './settings';

export interface WindowResult {
  windowId: number;
  /** Epoch ms at the start of the window. */
  time: number;
  /** Seconds since the session started, at the start of the window. */
  offsetSec: number;
  scores: Score[];
  detections: Score[];
  inferMs: number;
  geoApplied: boolean;
  /** Not persisted (e.g. the demo clip). */
  ephemeral: boolean;
}

export interface SessionStats {
  listening: boolean;
  startedAt: number | null;
  elapsedSec: number;
  windows: number;
  dropped: number;
  lastInferMs: number;
  contextSampleRate: number | null;
}

export interface RecordingState {
  recording: boolean;
  seconds: number;
}

export type WakeLockState = 'unsupported' | 'inactive' | 'active' | 'failed';
export type PipelineStage = 'mic' | 'resample' | 'window' | 'spectrogram' | 'network' | 'filter' | 'result';

export interface Notice {
  kind: 'info' | 'warn' | 'error';
  text: string;
}

interface ControllerEvents extends Record<string, unknown> {
  model: ModelStatus;
  engine: EngineState;
  chunk: Float32Array;
  level: number;
  'window-result': WindowResult;
  stats: SessionStats;
  recording: RecordingState;
  'recording-saved': RecordingRecord;
  wakelock: WakeLockState;
  location: LocationState;
  'geo-count': number;
  notice: Notice;
  stage: PipelineStage;
  'species-loaded': Species[];
  'detections-changed': undefined;
}

/** Orchestrates microphone capture, inference, persistence and device APIs. */
export class AppController extends Emitter<ControllerEvents> {
  readonly settings = new SettingsStore();
  readonly location: LocationManager;
  readonly inference = new InferenceClient();
  readonly engine: AudioEngine;
  species: Species[] = [];
  private speciesByName = new Map<string, Species>();
  private sessionId = newId();
  private sessionStartedAt: number | null = null;
  private windowCounter = 0;
  private stats: SessionStats = { listening: false, startedAt: null, elapsedSec: 0, windows: 0, dropped: 0, lastInferMs: 0, contextSampleRate: null };
  private timer: number | null = null;
  private recorder: Recorder | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private lastAutoClip = new Map<string, number>();
  private geoCount = 0;
  private modelReady = false;

  constructor(readonly baseUrl: string) {
    super();
    this.location = new LocationManager(this.settings);
    this.engine = new AudioEngine(`${baseUrl}worklet/capture-processor.js`, this.settings.get().overlapSeconds);
    this.inference.on('status', (s) => {
      this.modelReady = s.state === 'ready';
      this.emit('model', s);
    });
    this.inference.on('stage', (s) => this.emit('stage', s));
    this.engine.on('state', (s) => this.emit('engine', s));
    this.engine.on('chunk', (c) => this.onChunk(c));
    this.engine.on('level', (l) => this.emit('level', l));
    this.engine.on('window', (w) => void this.onWindow(w.audio, w.offsetSamples));
    this.engine.on('error', (text) => this.emit('notice', { kind: 'error', text }));
    this.location.on('change', (l) => {
      this.emit('location', l);
      void this.pushGeo();
    });
    this.settings.on('change', (s) => this.onSettings(s));
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => void this.onVisibility());
    }
  }

  getStats(): SessionStats {
    return this.stats;
  }

  getGeoCount(): number {
    return this.geoCount;
  }

  getRecordingState(): RecordingState {
    return { recording: this.recorder !== null, seconds: this.recorder?.seconds ?? 0 };
  }

  speciesByIndex(i: number): Species | undefined {
    return this.species[i];
  }

  speciesByScientific(name: string): Species | undefined {
    return this.speciesByName.get(name);
  }

  /** Load labels and the models. Safe to call once at startup. */
  async init(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}${LABELS_JSON}`);
      if (!res.ok) throw new Error(`labels ${res.status}`);
      this.species = parseLabels((await res.json()) as string[]);
      for (const s of this.species) this.speciesByName.set(s.scientific, s);
      this.emit('species-loaded', this.species);
    } catch (e) {
      this.emit('notice', { kind: 'error', text: `Could not load the species list: ${(e as Error).message}` });
    }
    try {
      await this.inference.init(this.baseUrl, this.settings.get().backend);
      await this.pushGeo();
    } catch (e) {
      this.emit('notice', { kind: 'error', text: `Model failed to load: ${(e as Error).message}` });
    }
    if (this.settings.get().locationMode === 'auto') void this.location.refresh();
  }

  private onSettings(s: Settings): void {
    this.engine.setOverlap(s.overlapSeconds);
    void this.pushGeo();
  }

  private async pushGeo(): Promise<void> {
    if (!this.modelReady) return;
    const loc = this.location.get();
    const s = this.settings.get();
    try {
      this.geoCount = await this.inference.setGeo(loc.location ? { lat: loc.location.lat, lon: loc.location.lon, week: loc.week } : null, s.geoThreshold);
      this.emit('geo-count', this.geoCount);
    } catch (e) {
      this.emit('notice', { kind: 'warn', text: `Location filter failed: ${(e as Error).message}` });
    }
  }

  // Listening -------------------------------------------------------------

  async startListening(): Promise<void> {
    if (this.engine.getState() !== 'stopped') return;
    if (this.settings.get().locationMode === 'auto' && !this.location.get().location) void this.location.refresh();
    try {
      await this.engine.start();
    } catch (err) {
      const e = describeMicError(err);
      this.emit('notice', { kind: 'error', text: e.message });
      throw err;
    }
    this.sessionId = newId();
    this.sessionStartedAt = Date.now();
    this.windowCounter = 0;
    this.stats = { listening: true, startedAt: this.sessionStartedAt, elapsedSec: 0, windows: 0, dropped: 0, lastInferMs: 0, contextSampleRate: this.engine.contextSampleRate };
    this.emit('stats', this.stats);
    this.timer = window.setInterval(() => {
      this.stats = { ...this.stats, elapsedSec: (Date.now() - (this.sessionStartedAt ?? Date.now())) / 1000 };
      this.emit('stats', this.stats);
      if (this.recorder) this.emit('recording', this.getRecordingState());
    }, 1000);
    await this.requestWakeLock();
  }

  async stopListening(): Promise<void> {
    await this.engine.stop();
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.recorder) await this.stopRecording();
    this.stats = { ...this.stats, listening: false };
    this.emit('stats', this.stats);
    await this.releaseWakeLock();
  }

  get listening(): boolean {
    return this.engine.getState() !== 'stopped';
  }

  private onChunk(chunk: Float32Array): void {
    this.emit('stage', 'mic');
    if (this.engine.contextSampleRate !== SAMPLE_RATE) this.emit('stage', 'resample');
    this.emit('chunk', chunk);
    this.recorder?.push(chunk);
    if (this.recorder?.full) {
      this.emit('notice', { kind: 'warn', text: 'Recording reached the 10 minute limit and was saved.' });
      void this.stopRecording();
    }
  }

  private async onWindow(audio: Float32Array, offsetSamples: number): Promise<void> {
    this.emit('stage', 'window');
    if (!this.modelReady || this.inference.busy) {
      this.stats = { ...this.stats, dropped: this.stats.dropped + 1 };
      return;
    }
    const s = this.settings.get();
    const copy = s.autoSaveClips ? audio.slice() : null;
    const windowId = ++this.windowCounter;
    const offsetSec = offsetSamples / SAMPLE_RATE;
    const time = (this.sessionStartedAt ?? Date.now()) + offsetSec * 1000;
    try {
      const res = await this.inference.analyze(audio);
      const detections = selectDetections(res.scores, this.species, { threshold: s.threshold, applyGeo: res.geoApplied, includeNonBird: s.includeNonBird });
      this.stats = { ...this.stats, windows: this.stats.windows + 1, lastInferMs: res.inferMs };
      this.emit('stage', 'result');
      const result: WindowResult = { windowId, time, offsetSec, scores: res.scores, detections, inferMs: res.inferMs, geoApplied: res.geoApplied, ephemeral: false };
      this.emit('window-result', result);
      if (detections.length > 0) await this.persistDetections(result, copy);
    } catch (e) {
      this.emit('notice', { kind: 'error', text: `Analysis failed: ${(e as Error).message}` });
    }
  }

  private async persistDetections(result: WindowResult, windowAudio: Float32Array | null): Promise<void> {
    const loc = this.location.get().location;
    const s = this.settings.get();
    let recordingId: string | null = null;
    if (s.autoSaveClips && windowAudio) {
      const best = result.detections[0];
      const sp = this.species[best.index];
      const last = this.lastAutoClip.get(sp.scientific) ?? 0;
      if (best.prob >= s.autoSaveMinConfidence && Date.now() - last > 30_000) {
        this.lastAutoClip.set(sp.scientific, Date.now());
        const rec = await this.saveRecording(windowAudio, `Auto clip: ${sp.common}`, 'autoclip', result.detections);
        recordingId = rec.id;
      }
    }
    const records: DetectionRecord[] = result.detections.map((d) => {
      const sp = this.species[d.index];
      return {
        id: newId(),
        time: result.time,
        label: sp.label,
        scientific: sp.scientific,
        common: sp.common,
        confidence: d.prob,
        lat: loc?.lat ?? null,
        lon: loc?.lon ?? null,
        accuracy: loc?.accuracy ?? null,
        recordingId,
        offsetSec: recordingId ? 0 : null,
        source: 'live',
        sessionId: this.sessionId,
      };
    });
    await addDetections(records);
    this.emit('detections-changed', undefined);
  }

  // Recording -------------------------------------------------------------

  startRecording(): void {
    if (this.recorder) return;
    this.recorder = new Recorder(SAMPLE_RATE);
    this.emit('recording', this.getRecordingState());
  }

  /** Stop recording and save it. Returns the saved record. */
  async stopRecording(): Promise<RecordingRecord | null> {
    const r = this.recorder;
    if (!r) return null;
    this.recorder = null;
    this.emit('recording', { recording: false, seconds: 0 });
    if (r.seconds < 0.5) {
      this.emit('notice', { kind: 'warn', text: 'Recording was too short to save.' });
      return null;
    }
    const rec = await this.saveRecording(r.toFloat32(), `Recording ${new Date(r.startedAt).toLocaleString()}`, 'mic', []);
    return rec;
  }

  async saveRecording(audio: Float32Array, name: string, source: RecordingRecord['source'], detections: Score[] = []): Promise<RecordingRecord> {
    const loc = this.location.get().location;
    const blob = new Blob([encodeWav(audio, SAMPLE_RATE)], { type: 'audio/wav' });
    const rec: RecordingRecord = {
      id: newId(),
      createdAt: Date.now(),
      name,
      durationSec: audio.length / SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
      bytes: blob.size,
      blob,
      source,
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
      accuracy: loc?.accuracy ?? null,
      summary: this.summarize(detections.map((d) => ({ index: d.index, prob: d.prob }))),
      analyzedAt: detections.length ? Date.now() : null,
    };
    await putRecording(rec);
    this.emit('recording-saved', rec);
    return rec;
  }

  summarize(entries: Array<{ index: number; prob: number }>): SpeciesSummary[] {
    const map = new Map<string, SpeciesSummary>();
    for (const e of entries) {
      const sp = this.species[e.index];
      if (!sp) continue;
      const cur = map.get(sp.scientific);
      if (cur) {
        cur.count++;
        cur.maxConfidence = Math.max(cur.maxConfidence, e.prob);
      } else map.set(sp.scientific, { label: sp.label, scientific: sp.scientific, common: sp.common, maxConfidence: e.prob, count: 1 });
    }
    return Array.from(map.values()).sort((a, b) => b.maxConfidence - a.maxConfidence);
  }

  /** Decode any audio file the browser understands into mono 48 kHz. */
  async decodeAudioFile(buffer: ArrayBuffer): Promise<Float32Array> {
    try {
      const OAC = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      const octx = new OAC(1, 1, SAMPLE_RATE);
      const decoded = await octx.decodeAudioData(buffer.slice(0));
      const chans: Float32Array[] = [];
      for (let c = 0; c < decoded.numberOfChannels; c++) chans.push(decoded.getChannelData(c));
      const mono = toMono(chans);
      return decoded.sampleRate === SAMPLE_RATE ? mono : resampleLinear(mono, decoded.sampleRate, SAMPLE_RATE);
    } catch {
      const wav = decodeWav(buffer);
      const mono = toMono(wav.channels);
      return wav.sampleRate === SAMPLE_RATE ? mono : resampleLinear(mono, wav.sampleRate, SAMPLE_RATE);
    }
  }

  /** Run the bundled demo clip through the same path as a live window (not persisted). */
  async analyzeDemoClip(url: string): Promise<WindowResult> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch sample (${res.status})`);
    const audio = await this.decodeAudioFile(await res.arrayBuffer());
    const win = audio.slice(0, WINDOW_SAMPLES);
    const padded = new Float32Array(WINDOW_SAMPLES);
    padded.set(win);
    for (const c of chunksOf(padded, 2048)) this.emit('chunk', c);
    this.emit('stage', 'window');
    const s = this.settings.get();
    const out = await this.inference.analyze(padded);
    const detections = selectDetections(out.scores, this.species, { threshold: s.threshold, applyGeo: false, includeNonBird: s.includeNonBird });
    this.emit('stage', 'result');
    const result: WindowResult = { windowId: ++this.windowCounter, time: Date.now(), offsetSec: 0, scores: out.scores, detections, inferMs: out.inferMs, geoApplied: false, ephemeral: true };
    this.emit('window-result', result);
    return result;
  }

  // Device APIs -----------------------------------------------------------

  private async requestWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) {
      this.emit('wakelock', 'unsupported');
      return;
    }
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
        if (this.listening) this.emit('wakelock', 'inactive');
      });
      this.emit('wakelock', 'active');
    } catch {
      this.emit('wakelock', 'failed');
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      await this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
    this.emit('wakelock', 'inactive');
  }

  private async onVisibility(): Promise<void> {
    if (document.visibilityState !== 'visible') return;
    if (this.listening) {
      await this.engine.resume();
      if (!this.wakeLock) await this.requestWakeLock();
    }
  }
}

function* chunksOf(a: Float32Array, size: number): Generator<Float32Array> {
  for (let i = 0; i < a.length; i += size) yield a.subarray(i, Math.min(a.length, i + size));
}

export const WINDOW_LENGTH_SEC = WINDOW_SECONDS;
