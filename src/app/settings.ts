import { Emitter } from '../shared/emitter';
import { DEFAULT_OVERLAP_SECONDS, GEO_FILTER_THRESHOLD } from '../model/constants';

export type { BackendPreference } from '../model/protocol';
import type { BackendPreference } from '../model/protocol';
export type LocationMode = 'auto' | 'manual' | 'off';
export type OcclusionResolution = 'coarse' | 'medium' | 'fine';
/** Listen screen arrangement (docs/DESIGN_GUIDE.md §6). BirdAmp is for approved members (DECISIONS.md #110). */
export type ListenLayout = 'consolidated' | 'dock' | 'focus' | 'birdamp';
const LAYOUTS: readonly ListenLayout[] = ['consolidated', 'dock', 'focus', 'birdamp'];
/** Map tab: cards under the map, one per bird or one per place (DECISIONS.md #72). */
export type MapCardsView = 'birds' | 'places';

export interface Settings {
  /** Stored-settings schema version; bumped when a saved default is migrated (see migrate()). */
  version: number;
  threshold: number;
  overlapSeconds: number;
  locationMode: LocationMode;
  manualLat: number | null;
  manualLon: number | null;
  /** The place picked by name for the manual location ("Ithaca, New York"); null when typed as numbers (DECISIONS.md #105). */
  manualPlace: string | null;
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
  /** Species tab: list every species instead of the local ones. */
  speciesShowAll: boolean;
  /** Species tab: list only species with at least one of your sightings ("Spotted by me"). */
  speciesSpottedOnly: boolean;
  listenLayout: ListenLayout;
  mapCardsView: MapCardsView;
}

/** Version of the stored settings shape. 2: default threshold moved from 25 % to 60 %. */
export const SETTINGS_VERSION = 4;
/** Default confidence threshold before version 2; a saved 25 % is migrated once to the default of the time. */
export const LEGACY_DEFAULT_THRESHOLD = 0.25;
/**
 * The default from version 2 until 2026-10-25, when new phones moved to 70 % (DECISIONS.md #95). Saved settings
 * always carry their threshold, so phones that saved one keep it; the 25 % migration still lands here.
 */
export const PREVIOUS_DEFAULT_THRESHOLD = 0.6;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  threshold: 0.7,
  overlapSeconds: DEFAULT_OVERLAP_SECONDS,
  locationMode: 'auto',
  manualLat: null,
  manualLon: null,
  manualPlace: null,
  geoThreshold: GEO_FILTER_THRESHOLD,
  useWeek: true,
  autoSaveClips: true,
  autoSaveMinConfidence: 0.7,
  backend: 'auto',
  occlusionResolution: 'medium',
  includeNonBird: false,
  showAdvancedViz: true,
  lowCut: true,
  speciesShowAll: false,
  speciesSpottedOnly: false,
  // First run (and after the user deletes all data) opens in Focus; a chosen layout is remembered (DECISIONS.md #63).
  listenLayout: 'focus',
  mapCardsView: 'birds',
};

/** localStorage key of the stored settings; its presence is one of the "returning visitor" signals (src/app/first-visit.ts). */
export const SETTINGS_KEY = 'birdbrain.settings.v1';
const KEY = SETTINGS_KEY;

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
 * becomes the default of the time (60 %); any other value was chosen by the user and
 * stays. Once stamped with version 2, a threshold of 25 % is a choice too.
 * Version 2 → 3: auto-saving 3-second detection windows is switched on once
 * (new default for everyone); turning it off afterwards is kept.
 * Version 3 → 4: "Why this ID" resolution set to Medium once; later choices are kept.
 */
export function migrate(parsed: Partial<Settings>): Settings {
  const stored = { ...DEFAULT_SETTINGS, ...parsed };
  const from = typeof parsed.version === 'number' ? parsed.version : 1;
  if (from < 2 && parsed.threshold === LEGACY_DEFAULT_THRESHOLD) stored.threshold = PREVIOUS_DEFAULT_THRESHOLD;
  // Version 3: auto-saving detection windows became the default for everyone, so it is switched on once for
  // settings saved earlier (the old default was off and saved settings cannot tell a choice from the default).
  if (from < 3) stored.autoSaveClips = true;
  // Version 4: "Why this ID" resolution moved to Medium for everyone, once (DECISIONS.md #62).
  if (from < 4) stored.occlusionResolution = 'medium';
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
    listenLayout: LAYOUTS.includes(s.listenLayout) ? s.listenLayout : DEFAULT_SETTINGS.listenLayout,
    mapCardsView: s.mapCardsView === 'places' ? 'places' : 'birds',
    // A clip is only saved for a detection, so the auto-save bar can never sit below the detection threshold.
    autoSaveMinConfidence: Math.max(threshold, clamp(s.autoSaveMinConfidence, 0.05, 0.99, DEFAULT_SETTINGS.autoSaveMinConfidence)),
    manualLat: s.manualLat == null || !Number.isFinite(s.manualLat) ? null : clamp(s.manualLat, -90, 90, 0),
    manualLon: s.manualLon == null || !Number.isFinite(s.manualLon) ? null : clamp(s.manualLon, -180, 180, 0),
    manualPlace: typeof s.manualPlace === 'string' && s.manualPlace.trim() ? s.manualPlace.trim().slice(0, 80) : null,
  };
}
