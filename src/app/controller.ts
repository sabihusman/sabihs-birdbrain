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
import { getClipMeta, newId, putRecording, recordDetections } from '../storage/db';
import type { ClipRecord, DetectionRecord, RecordingRecord, SpeciesSummary } from '../storage/types';
import { LocationManager, type LocationState } from './location';
import { PositionWatch, positionStamp, type PositionStamp } from './position-watch';
import { shouldAutoSaveClip, type LastAutoClip } from './autoclip';
import { SettingsStore, type Settings } from './settings';
import { localIndices, LocalSpeciesCache } from '../species/local';
import { isModelCached, markModelWanted, safeLocalStorage } from './first-visit';
import { askToKeepStorageOnce, PERSIST_REASON, persistOutcomeText } from '../storage/quota';

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
  /** Indices in `detections` that are there only because the user kept the bird against the location filter (DECISIONS.md #93). */
  soundOnly?: number[];
}

/**
 * A bird the sound model matched above the minimum this session but the location filter hid (DECISIONS.md #93):
 * its best window, where the phone was then, and whether the user kept it.
 */
export interface NotUsualBird {
  index: number;
  scientific: string;
  prob: number;
  time: number;
  where: PositionStamp;
  kept: boolean;
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
  /** Birds hidden by the location filter this session changed (one more seen, or one kept). */
  'not-usual': NotUsualBird[];
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
  /** Each bird's last auto-saved clip this session: a new one only when more confident (DECISIONS.md #96). */
  private lastAutoClip = new Map<string, LastAutoClip>();
  private geoCount = 0;
  private modelReady = false;
  private modelFailure: ModelFailure | null = null;
  /** True while loading a model that is already saved on the phone: the Listen panel says so instead of "Downloading". */
  modelFromCache = false;
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
        this.modelFromCache = await isModelCached(typeof caches === 'undefined' ? undefined : caches, MODEL_BASE_URL);
        await this.inference.init(MODEL_BASE_URL, this.settings.get().backend);
        await this.pushGeo();
        void this.refreshLocalSpecies();
        // Right after the first download: ask the browser to keep the model and the sightings (DECISIONS.md #84).
        // The outcome is said too, so this never claims it is handled while Settings says it is off (UI/UX audit finding 11).
        if (!this.modelFromCache)
          void askToKeepStorageOnce(safeLocalStorage(), undefined, () => this.emit('notice', { kind: 'info', text: PERSIST_REASON })).then((outcome) => {
            const text = persistOutcomeText(outcome);
            if (text) this.emit('notice', { kind: outcome === 'denied' ? 'warn' : 'info', text });
          });
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
    if (!loc.location) return { indices: null, note: loc.mode === 'off' ? 'All species: location filter off (Settings › Location).' : `All species: no location (${loc.message || loc.status}).` };
    const entry = this.localCache.current;
    if (!entry || this.localCache.needsRecompute(loc.location.lat, loc.location.lon)) {
      const model = this.inference.getStatus().state;
      const note = model === 'ready' ? 'All species until your local list is ready…' : model === 'idle' ? 'All species until your first identification loads the model.' : 'All species until the model loads.';
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
    this.saveWarned.clear();
    this.notUsual.clear();
    this.keptAgainstFilter.clear();
    this.notUsualAudio.clear();
    this.lastAutoClip.clear();
    this.emit('not-usual', []);
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
    let result: WindowResult;
    try {
      const res = await this.inference.analyze(audio);
      const filtered = selectDetections(res.scores, this.species, { threshold: s.threshold, applyGeo: res.geoApplied, includeNonBird: s.includeNonBird });
      // Matched by sound but hidden by the location filter: counted on Listen instead of vanishing; a bird the
      // user kept this session counts as a sighting from then on, marked sound-only (DECISIONS.md #93).
      const hidden = res.geoApplied ? selectDetections(res.scores, this.species, { threshold: s.threshold, applyGeo: false, includeNonBird: s.includeNonBird }).filter((d) => !d.inRange) : [];
      const kept = hidden.filter((d) => this.keptAgainstFilter.has(this.species[d.index]?.scientific ?? ''));
      const detections = kept.length ? [...filtered, ...kept].sort((a, b) => b.prob - a.prob) : filtered;
      this.noteNotUsual(hidden.filter((d) => !kept.includes(d)), time, copy);
      this.stats = { ...this.stats, windows: this.stats.windows + 1, lastInferMs: res.inferMs };
      this.emit('stage', 'result');
      result = { windowId, time, offsetSec, scores: res.scores, detections, inferMs: res.inferMs, geoApplied: res.geoApplied, ephemeral: false, soundOnly: kept.map((d) => d.index) };
      this.emit('window-result', result);
    } catch (e) {
      this.emit('notice', { kind: 'error', text: `Analysis failed: ${(e as Error).message}` });
      return;
    }
    // Saving is not analysis: the result is already on screen, so a storage failure says so
    // in its own words, once per session (DECISIONS.md #82).
    if (result.detections.length === 0) return;
    try {
      await this.persistDetections(result, copy);
    } catch (e) {
      this.warnSaveFailed('sighting', e);
    }
  }

  /** Birds hidden by the location filter this session, best window each, by scientific name (DECISIONS.md #93). */
  private notUsual = new Map<string, NotUsualBird>();
  /** Species the user kept this session: later windows count as sightings, marked sound-only. */
  private keptAgainstFilter = new Set<string>();
  /**
   * The raw 3 s behind each hidden bird's best window (only with auto-save on), so "Keep this sighting" can
   * save it to Recordings like any detection (DECISIONS.md #102). One window per species, this session only.
   */
  private notUsualAudio = new Map<string, { audio: Float32Array; scores: Score[] }>();

  private noteNotUsual(hidden: Score[], time: number, raw: Float32Array | null): void {
    if (hidden.length === 0) return;
    const where = positionStamp(this.positions.current());
    for (const d of hidden) {
      const sp = this.species[d.index];
      if (!sp) continue;
      const seen = this.notUsual.get(sp.scientific);
      if (!seen || d.prob > seen.prob) {
        this.notUsual.set(sp.scientific, { index: d.index, scientific: sp.scientific, prob: d.prob, time, where, kept: false });
        if (raw) this.notUsualAudio.set(sp.scientific, { audio: raw.slice(), scores: [d] });
      }
    }
    this.emit('not-usual', this.getNotUsual());
  }

  /** This session's birds hidden by the location filter, newest first; kept ones included, marked. */
  getNotUsual(): NotUsualBird[] {
    return Array.from(this.notUsual.values()).sort((a, b) => b.time - a.time);
  }

  /**
   * "Keep this sighting": save the bird's best window as a normal sighting, marked as verified by sound only,
   * and treat it as a sighting for the rest of the session. False when there is nothing to keep or the phone
   * refused the save (which says so once, as for any sighting).
   */
  async keepNotUsual(scientific: string): Promise<boolean> {
    const bird = this.notUsual.get(scientific);
    const sp = bird ? this.species[bird.index] : undefined;
    if (!bird || !sp || bird.kept) return false;
    // Its best window goes to Recordings as for any auto-saved detection; a clip that can't be stored never costs the sighting.
    let recordingId: string | null = null;
    const clip = this.notUsualAudio.get(scientific);
    if (clip && this.settings.get().autoSaveClips) {
      try {
        recordingId = (await this.saveRecording(clip.audio, `${AUTO_SAVE_RECORDING_PREFIX}: ${sp.common}`, 'autoclip', clip.scores)).id;
        this.lastAutoClip.set(sp.scientific, { time: Date.now(), confidence: bird.prob });
      } catch (e) {
        this.warnSaveFailed('clip', e);
      }
    }
    this.notUsualAudio.delete(scientific);
    const record: DetectionRecord = {
      id: newId(),
      time: bird.time,
      label: sp.label,
      scientific: sp.scientific,
      common: sp.common,
      confidence: bird.prob,
      lat: bird.where.lat,
      lon: bird.where.lon,
      accuracy: bird.where.accuracy,
      fixTime: bird.where.fixTime,
      recordingId,
      offsetSec: recordingId ? 0 : null,
      source: 'live',
      sessionId: this.sessionId,
      soundOnly: true,
    };
    try {
      await recordDetections([record]);
    } catch (e) {
      this.warnSaveFailed('sighting', e);
      return false;
    }
    bird.kept = true;
    this.keptAgainstFilter.add(scientific);
    this.emit('detections-changed', undefined);
    this.emit('not-usual', this.getNotUsual());
    return true;
  }

  private saveWarned = new Set<string>();
  /** One plain warning per kind and session when this phone's storage refuses a save. */
  private warnSaveFailed(what: 'sighting' | 'clip', e: unknown): void {
    if (this.saveWarned.has(what)) return;
    this.saveWarned.add(what);
    const text = what === 'sighting' ? 'Couldn’t save sightings' : 'Couldn’t save the audio clip';
    this.emit('notice', { kind: 'warn', text: `${text} (${(e as Error).message}). Identifying still works; a private tab can cause this.` });
  }

  private async persistDetections(result: WindowResult, windowAudio: Float32Array | null): Promise<void> {
    // The newest fix as of this window. No fix means no position: never an old one.
    const where = positionStamp(this.positions.current());
    const s = this.settings.get();
    let recordingId: string | null = null;
    if (s.autoSaveClips && windowAudio) {
      const best = result.detections[0];
      const sp = this.species[best.index];
      if (shouldAutoSaveClip(this.lastAutoClip.get(sp.scientific), best.prob, s.autoSaveMinConfidence, Date.now())) {
        this.lastAutoClip.set(sp.scientific, { time: Date.now(), confidence: best.prob });
        // A clip that cannot be stored must not cost the sighting itself (DECISIONS.md #82).
        try {
          const rec = await this.saveRecording(windowAudio, `${AUTO_SAVE_RECORDING_PREFIX}: ${sp.common}`, 'autoclip', result.detections);
          recordingId = rec.id;
        } catch (e) {
          this.warnSaveFailed('clip', e);
        }
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
        ...(result.soundOnly?.includes(d.index) ? { soundOnly: true } : {}),
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
      const existing = await getClipMeta(det.scientific).catch(() => undefined);
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
        this.warnSaveFailed('clip', e);
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
