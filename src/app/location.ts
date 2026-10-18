import { Emitter } from '../shared/emitter';
import { type GeoLocation, isValidLatLon, NO_WEEK, weekOfYear48 } from '../model/geo';
import type { LocationMode, Settings, SettingsStore } from './settings';

/** Wrap the Geolocation API in a promise with a timeout. */
export function getCurrentPosition(timeoutMs = 15000): Promise<GeoLocation> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Geolocation is not supported on this device'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          source: 'gps',
        }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60 * 1000 },
    );
  });
}

export type LocationStatus = 'off' | 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable' | 'manual-missing';

export interface LocationState {
  mode: LocationMode;
  location: GeoLocation | null;
  /** BirdNET week 1-48, or -1 when seasonal filtering is off. */
  week: number;
  status: LocationStatus;
  message: string;
}

/**
 * Resolves the position used for the location/season filter from the
 * settings: GPS (auto), manual coordinates, or off.
 */
export class LocationManager extends Emitter<{ change: LocationState }> {
  private state: LocationState;
  private inflight: Promise<void> | null = null;

  constructor(private settings: SettingsStore) {
    super();
    this.state = this.derive(settings.get(), null, 'idle', '');
    settings.on('change', (s) => this.applySettings(s));
  }

  get(): LocationState {
    return this.state;
  }

  private derive(s: Settings, gps: GeoLocation | null, status: LocationStatus, message: string): LocationState {
    const week = s.useWeek ? weekOfYear48(new Date()) : NO_WEEK;
    if (s.locationMode === 'off') return { mode: 'off', location: null, week, status: 'off', message: 'Location filter off' };
    if (s.locationMode === 'manual') {
      if (s.manualLat != null && s.manualLon != null && isValidLatLon(s.manualLat, s.manualLon)) {
        return {
          mode: 'manual',
          location: { lat: s.manualLat, lon: s.manualLon, accuracy: null, source: 'manual' },
          week,
          status: 'ok',
          message: `Manual location ${s.manualLat.toFixed(3)}, ${s.manualLon.toFixed(3)}`,
        };
      }
      return { mode: 'manual', location: null, week, status: 'manual-missing', message: 'Enter latitude and longitude in Settings' };
    }
    return { mode: 'auto', location: gps, week, status, message };
  }

  private set(next: LocationState): void {
    this.state = next;
    this.emit('change', next);
  }

  private applySettings(s: Settings): void {
    const keepGps = s.locationMode === 'auto' && this.state.mode === 'auto' ? this.state.location : null;
    const status: LocationStatus = keepGps ? 'ok' : this.state.mode === 'auto' && s.locationMode === 'auto' ? this.state.status : 'idle';
    this.set(this.derive(s, keepGps, status, keepGps ? this.state.message : ''));
    if (s.locationMode === 'auto' && !keepGps) void this.refresh();
  }

  /** Ask the device for its position (auto mode only). Safe to call repeatedly. */
  refresh(): Promise<void> {
    if (this.settings.get().locationMode !== 'auto') return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.set({ ...this.state, status: 'locating', message: 'Finding your location…' });
    this.inflight = getCurrentPosition()
      .then((loc) => {
        this.set(this.derive(this.settings.get(), loc, 'ok', `GPS ±${loc.accuracy ? Math.round(loc.accuracy) : '?'} m`));
      })
      .catch((err: unknown) => {
        const code = typeof err === 'object' && err && 'code' in err ? (err as { code: number }).code : 0;
        const denied = code === 1;
        this.set(
          this.derive(
            this.settings.get(),
            null,
            denied ? 'denied' : 'unavailable',
            denied ? 'Location denied. Enter coordinates manually in Settings or turn the filter off.' : 'Location unavailable. Enter coordinates manually in Settings or turn the filter off.',
          ),
        );
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
