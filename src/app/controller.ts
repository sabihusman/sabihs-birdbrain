import { AudioEngine, describeMicError, type EngineState, type StartError } from '../audio/engine';
import { Recorder } from '../audio/recorder';
import { ConditionsMeter, type ConditionsAssessment } from '../audio/conditions';
import { renderLowCut } from '../audio/highpass';
import type { VoiceProcessingReport } from '../audio/mic-constraints';
import { SampleRing } from '../audio/ring-buffer';
import { CLIP_MAX_SECONDS, clipRange, saveClipIfBetter, shouldReplaceClip, windowsInClip, type ClipCandidate, type TimedWindow } from '../species/clips';
import { decodeWav, encodeWav, toMono } from '../audio/wav';
import { resampleLinear } from '../audio/resample';
import { LABELS_JSON, SAMPLE_RATE, WINDOW_SAMPLES, WINDOW_SECONDS } from '../model/constants';
import { MODEL_BASE_URL, MODEL_DOWNLOAD_ERROR } from '../model/model-source';
import { BrowserUnsupportedError, checkBrowserSupport, describeModelFailure } from './browser-support';
import { parseLabels, type Species } from '../model/labels';
import { selectDetections, type Score } from '../model/postprocess';
import { InferenceClient, type ModelStatus } from '../model/worker-client';
import { Emitter } from '../shared/emitter';
import { getClip, newId, putRecording, recordDetections } from '../storage/db';
import type { ClipRecord, DetectionRecord, RecordingRecord, SpeciesSummary } from '../storage/types';
import { LocationManager, type LocationState } from './location';
import { PositionWatch, positionStamp } from './position-watch';
import { SettingsStore, type Settings } from './settings';
import { localIndices, LocalSpeciesCache } from '../species/local';
import { markModelWanted, safeLocalStorage } from './first-visit';

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
  /** The local species list changed (position moved, model ready, or the range threshold changed). */
  'local-species': LocalSpeciesState;
  notice: Notice;
  stage: PipelineStage;
  'species-loaded': Species[];
  'detections-changed': undefined;
  /** Listening conditions from the raw microphone audio, about once a second. */
  conditions: ConditionsAssessment;
  /** Voice-processing settings the browser applied to the microphone track. */
  mic: VoiceProcessingReport;
  /** A species clip was saved or replaced. */
  'clip-saved': ClipRecord;
  /** The first-visit welcome layer is shown (true) or was dismissed (false). */
  welcome: boolean;
}

/** Seconds of raw live audio kept so a species clip can be centred on its detection window. */
const LIVE_RING_SECONDS = 24;

interface PendingLiveClip {
  candidate: ClipCandidate;
  /** Detection window start, in session samples. */
  offsetSamples: number;
}

/** How a saved detection window is named in Recordings (the auto-save setting, not the species ID clip). */
export const AUTO_SAVE_RECORDING_PREFIX = 'Detection window';

export interface ModelFailure {
  /** The browser cannot run the model at all (no download was started; "Try again" cannot help). */
  unsupported: boolean;
  /** Plain words for the Listen panel and the toast (src/app/browser-support.ts). */
  text: string;
}

export interface LocalSpeciesState {
  /** Species indices the geo model scores at or above the range threshold in any week; null when no position is known. */
  indices: Set<number> | null;
  /** Why the list is unavailable, when it is. */
  note: string | null;
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
  private modelFailure: ModelFailure | null = null;
  private localCache = new LocalSpeciesCache();
  private micError: StartError | null = null;
  private localComputing: Promise<void> | null = null;
  /** Live position watch, running only while listening. */
  readonly positions: PositionWatch;
  private conditions = new ConditionsMeter(SAMPLE_RATE, (a) => this.emit('conditions', a));
  /** Raw (unfiltered) live audio for species clips; member feature, see setClipsEnabled. */
  private liveRing = new SampleRing(SAMPLE_RATE * LIVE_RING_SECONDS);
  private pendingClips = new Map<string, PendingLiveClip>();
  /** Per species, the live windows (session seconds) that detected it, for the clip's identifying-window list. */
  private liveWindows = new Map<string, TimedWindow[]>();
  private clipsEnabled = false;
  /** First visit: the Listen view shows the welcome layer and nothing downloads until "Start identifying" (DECISIONS.md #68). */
  private welcome = false;
  /** The in-flight model load, shared so a second caller never starts a second worker init. */
  private modelLoading: Promise<boolean> | null = null;
  /** Load the model in init(): only when this phone asked for it before (DECISIONS.md #69). */
  private autoLoadModel = false;

  constructor(readonly baseUrl: string) {
    super();
    this.location = new LocationManager(this.settings);
    // Two separate uses of location (DECISIONS.md #58): `location` is the coarse fix the
    // species filter needs, `positions` is the live watch a sighting is stamped from.
    this.positions = new PositionWatch();
    this.engine = new AudioEngine(`${baseUrl}worklet/capture-processor.js`, this.settings.get().overlapSeconds, this.settings.get().lowCut);
    this.inference.on('status', (s) => {
      this.modelReady = s.state === 'ready';
      this.emit('model', s);
    });
    this.inference.on('stage', (s) => this.emit('stage', s));
    this.engine.on('state', (s) => this.emit('engine', s));
    this.engine.on('chunk', (c) => this.onChunk(c));
    this.engine.on('level', (l) => this.emit('level', l));
    this.engine.on('window', (w) => void this.onWindow(w.audio, w.raw, w.offsetSamples));
    this.engine.on('mic', (r) => this.emit('mic', r));
    this.engine.on('error', (text) => this.emit('notice', { kind: 'error', text }));
    this.location.on('change', (l) => {
      this.emit('location', l);
      void this.pushGeo();
      void this.refreshLocalSpecies();
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

  /** Whether the welcome layer is up (first visit, nothing chosen yet). */
  get welcomePending(): boolean {
    return this.welcome;
  }

  /** Decided by main.ts before the first paint, from the stored and cached signals (src/app/first-visit.ts). */
  setWelcomePending(on: boolean): void {
    if (this.welcome === on) return;
    this.welcome = on;
    this.emit('welcome', on);
  }

  /** Decided by main.ts from the same signals: cached or flagged phones get the model at startup. */
  setAutoLoadModel(on: boolean): void {
    this.autoLoadModel = on;
  }

  /** "Start identifying" on the welcome layer: remember the choice, take the layer down and start the download. */
  startIdentifying(): void {
    this.setWelcomePending(false);
    void this.ensureModel();
  }

  /**
   * The model, loaded on demand (DECISIONS.md #69): every identifying action (Listen's
   * start, the sample clip, an import, "Start identifying") goes through here, so the
   * first one downloads and the flag makes the next visit load at startup. Resolves true
   * when inference is ready, false when the download failed (a notice was shown).
   */
  async ensureModel(): Promise<boolean> {
    markModelWanted(safeLocalStorage());
    return this.modelReady ? true : this.loadModel();
  }

  /** Load the species list, and the model when this phone asked for it before. Safe to call once at startup. */
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
    // A browser that cannot run the model is told so at once, before any tap (DECISIONS.md #65): the
    // check costs nothing and downloads nothing, and "Start identifying" would only fail later.
    const support = checkBrowserSupport();
    if (!support.ok) {
      this.modelFailure = { unsupported: true, text: describeModelFailure(new BrowserUnsupportedError(support.reason)) };
      this.emit('model', this.inference.getStatus());
    }
    // Nothing downloads on its own: only a phone that asked for the model before loads it here.
    else if (this.autoLoadModel && !this.welcome) await this.loadModel();
    if (this.settings.get().locationMode === 'auto') void this.location.refresh();
  }

  /**
   * Download and warm up the models from MODEL_BASE_URL (the API host in production).
   * Called by init() for returning phones, by ensureModel() on the first identifying
   * action, and again by the Listen screen's "Try again" after a failed download,
   * which is the common case on a flaky phone connection.
   */
  async loadModel(): Promise<boolean> {
    if (this.modelReady) return true;
    if (this.modelLoading) return this.modelLoading;
    this.modelLoading = (async () => {
      try {
        // Before any byte is requested: a browser without WebAssembly cannot run the model,
        // so there is nothing to download (DECISIONS.md #65).
        const support = checkBrowserSupport();
        if (!support.ok) throw new BrowserUnsupportedError(support.reason);
        this.modelFailure = null;
        await this.inference.init(MODEL_BASE_URL, this.settings.get().backend);
        await this.pushGeo();
        void this.refreshLocalSpecies();
        return true;
      } catch (e) {
        // The technical reason stays in the console; the member reads what to do about it.
        console.warn('[model] load failed', e);
        this.modelFailure = { unsupported: e instanceof BrowserUnsupportedError, text: describeModelFailure(e) };
        if (this.modelFailure.unsupported) this.emit('model', this.inference.getStatus()); // no toast: the Listen panel says it, and "Try again" cannot help
        else this.emit('notice', { kind: 'error', text: this.modelFailure.text });
        return false;
      } finally {
        this.modelLoading = null;
      }
    })();
    return this.modelLoading;
  }

  /** Why the last model load failed, in plain words; null when it has not failed. */
  getModelFailure(): ModelFailure | null {
    return this.modelFailure;
  }

  private onSettings(s: Settings): void {
    this.engine.setOverlap(s.overlapSeconds);
    this.engine.setLowCut(s.lowCut);
    void this.pushGeo();
    this.emit('local-species', this.getLocalSpecies()); // the range threshold may have changed
  }

  // Local species (Species tab) ---------------------------------------------

  /** Local list at the current range threshold, from the cached year-round geo scores. */
  getLocalSpecies(): LocalSpeciesState {
    const loc = this.location.get();
    if (!loc.location) return { indices: null, note: loc.mode === 'off' ? 'Showing all species: the location filter is off (Settings › Location).' : `Showing all species: no location is available (${loc.message || loc.status}).` };
    const entry = this.localCache.current;
    if (!entry || this.localCache.needsRecompute(loc.location.lat, loc.location.lon)) {
      const model = this.inference.getStatus().state;
      const note = model === 'ready' ? 'Showing all species while the local list is being computed…' : model === 'idle' ? 'Showing all species: the local list needs the bird model, which loads the first time you identify a bird.' : 'Showing all species until the model has loaded.';
      return { indices: null, note };
    }
    return { indices: localIndices(entry.maxProbs, this.settings.get().geoThreshold), note: null };
  }

  /** Recompute the cached year-round scores when the position moved more than 25 km (or nothing is cached). */
  private async refreshLocalSpecies(): Promise<void> {
    const loc = this.location.get().location;
    if (!loc || !this.modelReady) {
      this.emit('local-species', this.getLocalSpecies());
      return;
    }
    if (!this.localCache.needsRecompute(loc.lat, loc.lon)) {
      this.emit('local-species', this.getLocalSpecies());
      return;
    }
    if (this.localComputing) return;
    this.localComputing = (async () => {
      try {
        const maxProbs = await this.inference.localSpecies(loc.lat, loc.lon);
        this.localCache.set({ lat: loc.lat, lon: loc.lon, maxProbs, computedAt: Date.now() });
      } catch (e) {
        this.emit('notice', { kind: 'warn', text: `Local species list failed: ${(e as Error).message}` });
      } finally {
        this.localComputing = null;
        this.emit('local-species', this.getLocalSpecies());
      }
    })();
    await this.localComputing;
  }

  /** Last known microphone voice-processing report ('unknown' until a session has started). */
  getMicReport(): VoiceProcessingReport {
    return this.engine.getMicReport();
  }

  /** Latest conditions assessment of the current session, if any. */
  getConditions(): ConditionsAssessment | null {
    return this.conditions.current;
  }

  /**
   * Apply the same low-cut the live path uses to a clip that is about to be
   * analysed (import, re-analyse, demo, "Why this ID"). Returns the input
   * untouched when the setting is off. Never used for audio that gets saved.
   */
  async prepareForAnalysis(audio: Float32Array): Promise<Float32Array> {
    return this.settings.get().lowCut ? renderLowCut(audio, SAMPLE_RATE) : audio;
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
    // The first start on a phone downloads the model first; the Listen view shows the progress meanwhile.
    if (!(await this.ensureModel())) throw new Error(this.modelFailure?.text ?? MODEL_DOWNLOAD_ERROR);
    if (this.settings.get().locationMode === 'auto' && !this.location.get().location) void this.location.refresh();
    // Follow the walk: each sighting is stamped with the newest fix, not with one from
    // page load. Off again in stopListening(), so the GPS is not left running.
    if (this.settings.get().locationMode !== 'off') this.positions.start();
    this.micError = null;
    try {
      await this.engine.start();
    } catch (err) {
      const e = describeMicError(err);
      this.micError = e;
      this.emit('notice', { kind: 'error', text: e.message });
      throw err;
    }
    this.sessionId = newId();
    this.sessionStartedAt = Date.now();
    this.windowCounter = 0;
    this.conditions.reset();
    this.liveRing.reset();
    this.pendingClips.clear();
    this.liveWindows.clear();
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
    this.positions.stop();
    await this.engine.stop();
    await this.flushPendingClips(true);
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

  /** Why the last start failed (denied, no mic, …), or null. */
  getMicError(): StartError | null {
    return this.micError;
  }

  /** The audio context was suspended (app in the background); resume it from a tap. */
  async resumeListening(): Promise<void> {
    if (!this.listening) return;
    await this.engine.resume();
    if (!this.wakeLock) await this.requestWakeLock();
  }

  private onChunk(chunk: Float32Array): void {
    this.emit('stage', 'mic');
    if (this.engine.contextSampleRate !== SAMPLE_RATE) this.emit('stage', 'resample');
    this.emit('chunk', chunk);
    this.conditions.push(chunk);
    if (this.clipsEnabled) {
      this.liveRing.push(chunk);
      if (this.pendingClips.size) void this.flushPendingClips(false);
    }
    this.recorder?.push(chunk);
    if (this.recorder?.full) {
      this.emit('notice', { kind: 'warn', text: 'Recording reached the 10 minute limit and was saved.' });
      void this.stopRecording();
    }
  }

  private async onWindow(audio: Float32Array, raw: Float32Array | null, offsetSamples: number): Promise<void> {
    this.emit('stage', 'window');
    if (!this.modelReady || this.inference.busy) {
      this.stats = { ...this.stats, dropped: this.stats.dropped + 1 };
      return;
    }
    const s = this.settings.get();
    // Auto-save clips keep the raw (unfiltered) audio so they can be re-analysed later.
    const copy = s.autoSaveClips ? raw : null;
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
    // The newest fix as of this window. No fix means no position: never an old one.
    const where = positionStamp(this.positions.current());
    const s = this.settings.get();
    let recordingId: string | null = null;
    if (s.autoSaveClips && windowAudio) {
      const best = result.detections[0];
      const sp = this.species[best.index];
      const last = this.lastAutoClip.get(sp.scientific) ?? 0;
      if (best.prob >= s.autoSaveMinConfidence && Date.now() - last > 30_000) {
        this.lastAutoClip.set(sp.scientific, Date.now());
        const rec = await this.saveRecording(windowAudio, `${AUTO_SAVE_RECORDING_PREFIX}: ${sp.common}`, 'autoclip', result.detections);
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
        lat: where.lat,
        lon: where.lon,
        accuracy: where.accuracy,
        fixTime: where.fixTime,
        recordingId,
        offsetSec: recordingId ? 0 : null,
        source: 'live',
        sessionId: this.sessionId,
      };
    });
    await recordDetections(records);
    this.emit('detections-changed', undefined);
    if (this.clipsEnabled) {
      const offsetSamples = Math.round(result.offsetSec * SAMPLE_RATE);
      for (const r of records) {
        this.rememberLiveWindow(r.scientific, { startSec: result.offsetSec, confidence: r.confidence });
        await this.queueLiveClip(r, offsetSamples);
      }
    }
  }

  // Species clips (member feature) ------------------------------------------

  /** Clips are only collected while an approved member is signed in. Existing clips are never deleted here. */
  setClipsEnabled(on: boolean): void {
    this.clipsEnabled = on;
    if (!on) {
      this.pendingClips.clear();
      this.liveWindows.clear();
    }
  }

  /** Keep the species' recent detection windows (those still inside the raw ring) so the clip can list all that fall in it. */
  private rememberLiveWindow(scientific: string, w: TimedWindow): void {
    const oldest = this.liveRing.start / SAMPLE_RATE;
    const kept = (this.liveWindows.get(scientific) ?? []).filter((x) => x.startSec + WINDOW_SECONDS > oldest);
    kept.push(w);
    this.liveWindows.set(scientific, kept);
  }

  get clipsCollected(): boolean {
    return this.clipsEnabled;
  }

  /**
   * Remember a live detection whose clip should be cut once the audio after
   * the window has arrived. A later, more confident detection of the same
   * species replaces the pending one.
   */
  private async queueLiveClip(det: DetectionRecord, offsetSamples: number): Promise<void> {
    const candidate: ClipCandidate = { scientific: det.scientific, common: det.common, confidence: det.confidence, time: det.time, lat: det.lat, lon: det.lon, accuracy: det.accuracy, fixTime: det.fixTime ?? null, source: 'live', recordingId: null, windows: [] };
    const pending = this.pendingClips.get(det.scientific);
    if (pending && !shouldReplaceClip(pending.candidate, candidate)) return;
    if (!pending) {
      const existing = await getClip(det.scientific).catch(() => undefined);
      if (!shouldReplaceClip(existing, candidate)) return;
    }
    this.pendingClips.set(det.scientific, { candidate, offsetSamples });
  }

  /** Cut and save pending clips whose tail has arrived (or everything, when the session ends). */
  private async flushPendingClips(final: boolean): Promise<void> {
    const padSamples = Math.round(((CLIP_MAX_SECONDS - WINDOW_SECONDS) / 2) * SAMPLE_RATE);
    for (const [scientific, p] of Array.from(this.pendingClips.entries())) {
      const windowEnd = p.offsetSamples + WINDOW_SAMPLES;
      if (!final && windowEnd + padSamples > this.liveRing.end) continue;
      this.pendingClips.delete(scientific);
      const available = { start: this.liveRing.start / SAMPLE_RATE, end: this.liveRing.end / SAMPLE_RATE };
      const range = clipRange({ start: p.offsetSamples / SAMPLE_RATE, end: windowEnd / SAMPLE_RATE }, available);
      const startSamples = Math.round(range.start * SAMPLE_RATE);
      const length = Math.round((range.end - range.start) * SAMPLE_RATE);
      const audio = this.liveRing.slice(startSamples, length);
      if (!audio) continue;
      // Every window of the species that falls inside the clip, the triggering one included.
      const windows = windowsInClip([...(this.liveWindows.get(scientific) ?? []), { startSec: p.offsetSamples / SAMPLE_RATE, confidence: p.candidate.confidence }], range);
      try {
        const saved = await saveClipIfBetter({ ...p.candidate, windows }, audio);
        if (saved) this.emit('clip-saved', saved);
      } catch (e) {
        this.emit('notice', { kind: 'warn', text: `Could not save the species clip: ${(e as Error).message}` });
      }
    }
  }

  /**
   * Offer a clip cut from a recording or import (raw audio, already sliced to
   * at most 10 s). Saved only when clips are enabled and the confidence beats
   * the stored clip. Returns the saved record or null.
   */
  async offerClip(candidate: ClipCandidate, audio: Float32Array): Promise<ClipRecord | null> {
    if (!this.clipsEnabled) return null;
    const saved = await saveClipIfBetter(candidate, audio);
    if (saved) this.emit('clip-saved', saved);
    return saved;
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
    // While listening the watch is the truth; otherwise fall back to the filter's coarse
    // fix, which is all an imported file can have.
    const live = this.positions.current();
    const loc = live ?? this.location.get().location;
    const fixTime = live ? live.time : null;
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
      fixTime,
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
    if (!(await this.ensureModel())) throw new Error(this.modelFailure?.text ?? MODEL_DOWNLOAD_ERROR);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch sample (${res.status})`);
    const audio = await this.decodeAudioFile(await res.arrayBuffer());
    const win = audio.slice(0, WINDOW_SAMPLES);
    const padded = new Float32Array(WINDOW_SAMPLES);
    padded.set(win);
    for (const c of chunksOf(padded, 2048)) this.emit('chunk', c);
    this.emit('stage', 'window');
    const s = this.settings.get();
    const out = await this.inference.analyze(await this.prepareForAnalysis(padded));
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
