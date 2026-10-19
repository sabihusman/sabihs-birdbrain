import { Emitter } from '../shared/emitter';
import { DEFAULT_OVERLAP_SECONDS, GEO_FILTER_THRESHOLD } from '../model/constants';

export type { BackendPreference } from '../model/protocol';
import type { BackendPreference } from '../model/protocol';
export type LocationMode = 'auto' | 'manual' | 'off';
export type OcclusionResolution = 'coarse' | 'medium' | 'fine';
/** Listen screen arrangement (docs/DESIGN_GUIDE.md §6). */
export type ListenLayout = 'consolidated' | 'dock' | 'focus';

export interface Settings {
  /** Stored-settings schema version; bumped when a saved default is migrated (see migrate()). */
  version: number;
  threshold: number;
  overlapSeconds: number;
  locationMode: LocationMode;
  manualLat: number | null;
  manualLon: number | null;
  geoThreshold: number;
  useWeek: boolean;
  autoSaveClips: boolean;
  autoSaveMinConfidence: number;
  backend: BackendPreference;
  occlusionResolution: OcclusionResolution;
  includeNonBird: boolean;
  showAdvancedViz: boolean;
  /** 150 Hz high-pass on the analysis path (live and imported clips). Saved audio is never filtered. */
  lowCut: boolean;
  /** Seconds without a species after which its next detection starts a new sighting. */
  sightingGapSeconds: number;
  /** Species tab: list every species instead of the local ones. */
  speciesShowAll: boolean;
  /** Species tab: list only species with at least one of your sightings ("Spotted by me"). */
  speciesSpottedOnly: boolean;
  listenLayout: ListenLayout;
}

/** Version of the stored settings shape. 2: default threshold moved from 25 % to 60 %. */
export const SETTINGS_VERSION = 2;
/** Default confidence threshold before version 2; a saved 25 % is migrated once to the new default. */
export const LEGACY_DEFAULT_THRESHOLD = 0.25;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  threshold: 0.6,
  overlapSeconds: DEFAULT_OVERLAP_SECONDS,
  locationMode: 'auto',
  manualLat: null,
  manualLon: null,
  geoThreshold: GEO_FILTER_THRESHOLD,
  useWeek: true,
  autoSaveClips: false,
  autoSaveMinConfidence: 0.6,
  backend: 'auto',
  occlusionResolution: 'coarse',
  includeNonBird: false,
  showAdvancedViz: true,
  lowCut: true,
  sightingGapSeconds: 60,
  speciesShowAll: false,
  speciesSpottedOnly: false,
  listenLayout: 'consolidated',
};

const KEY = 'birdbrain.settings.v1';

export class SettingsStore extends Emitter<{ change: Settings }> {
  private current: Settings;

  constructor(private storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    super();
    this.current = SettingsStore.load(storage);
  }

  static load(storage: Storage | null): Settings {
    if (!storage) return { ...DEFAULT_SETTINGS };
    try {
      const raw = storage.getItem(KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return sanitize(migrate(parsed));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): Settings {
    return this.current;
  }

  update(patch: Partial<Settings>): Settings {
    this.current = sanitize({ ...this.current, ...patch });
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.current));
    } catch {
      /* storage full or unavailable */
    }
    this.emit('change', this.current);
    return this.current;
  }
}

/**
 * One-time migrations of saved settings, keyed by the stored `version`.
 * Version 1 (or none) → 2: a saved threshold equal to the old default (25 %)
 * becomes the new default (60 %); any other value was chosen by the user and
 * stays. Once stamped with version 2, a threshold of 25 % is a choice too.
 */
export function migrate(parsed: Partial<Settings>): Settings {
  const stored = { ...DEFAULT_SETTINGS, ...parsed };
  const from = typeof parsed.version === 'number' ? parsed.version : 1;
  if (from < 2 && parsed.threshold === LEGACY_DEFAULT_THRESHOLD) stored.threshold = DEFAULT_SETTINGS.threshold;
  stored.version = SETTINGS_VERSION;
  return stored;
}

export function sanitize(s: Settings): Settings {
  const clamp = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  const threshold = clamp(s.threshold, 0.05, 0.99, DEFAULT_SETTINGS.threshold);
  return {
    ...s,
    version: SETTINGS_VERSION,
    threshold,
    overlapSeconds: clamp(s.overlapSeconds, 0, 2.5, DEFAULT_SETTINGS.overlapSeconds),
    geoThreshold: clamp(s.geoThreshold, 0, 1, DEFAULT_SETTINGS.geoThreshold),
    sightingGapSeconds: clamp(s.sightingGapSeconds, 5, 600, DEFAULT_SETTINGS.sightingGapSeconds),
    listenLayout: s.listenLayout === 'dock' || s.listenLayout === 'focus' ? s.listenLayout : 'consolidated',
    // A clip is only saved for a detection, so the auto-save bar can never sit below the detection threshold.
    autoSaveMinConfidence: Math.max(threshold, clamp(s.autoSaveMinConfidence, 0.05, 0.99, DEFAULT_SETTINGS.autoSaveMinConfidence)),
    manualLat: s.manualLat == null || !Number.isFinite(s.manualLat) ? null : clamp(s.manualLat, -90, 90, 0),
    manualLon: s.manualLon == null || !Number.isFinite(s.manualLon) ? null : clamp(s.manualLon, -180, 180, 0),
  };
}
