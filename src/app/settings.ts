import { Emitter } from '../shared/emitter';
import { DEFAULT_OVERLAP_SECONDS, GEO_FILTER_THRESHOLD } from '../model/constants';

export type { BackendPreference } from '../model/protocol';
import type { BackendPreference } from '../model/protocol';
export type LocationMode = 'auto' | 'manual' | 'off';
export type OcclusionResolution = 'coarse' | 'medium' | 'fine';

export interface Settings {
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
}

export const DEFAULT_SETTINGS: Settings = {
  threshold: 0.25,
  overlapSeconds: DEFAULT_OVERLAP_SECONDS,
  locationMode: 'auto',
  manualLat: null,
  manualLon: null,
  geoThreshold: GEO_FILTER_THRESHOLD,
  useWeek: true,
  autoSaveClips: false,
  autoSaveMinConfidence: 0.5,
  backend: 'auto',
  occlusionResolution: 'coarse',
  includeNonBird: false,
  showAdvancedViz: true,
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
      return sanitize({ ...DEFAULT_SETTINGS, ...parsed });
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

export function sanitize(s: Settings): Settings {
  const clamp = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  return {
    ...s,
    threshold: clamp(s.threshold, 0.05, 0.99, DEFAULT_SETTINGS.threshold),
    overlapSeconds: clamp(s.overlapSeconds, 0, 2.5, DEFAULT_SETTINGS.overlapSeconds),
    geoThreshold: clamp(s.geoThreshold, 0, 1, DEFAULT_SETTINGS.geoThreshold),
    autoSaveMinConfidence: clamp(s.autoSaveMinConfidence, 0.05, 0.99, DEFAULT_SETTINGS.autoSaveMinConfidence),
    manualLat: s.manualLat == null || !Number.isFinite(s.manualLat) ? null : clamp(s.manualLat, -90, 90, 0),
    manualLon: s.manualLon == null || !Number.isFinite(s.manualLon) ? null : clamp(s.manualLon, -180, 180, 0),
  };
}
