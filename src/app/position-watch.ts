import { Emitter } from '../shared/emitter';

/**
 * The position a sighting is stamped with, kept apart from the coarse location the
 * species filter uses (src/app/location.ts).
 *
 * Before this, every sighting carried the one fix taken when the page loaded, so a whole
 * walk landed on the same spot. While listening, this watches the device with
 * `watchPosition` at high accuracy and keeps the newest fix; each detection takes the fix
 * as it was at that moment, with its accuracy and the time the device produced it.
 * Nothing here is uploaded: sightings stay on the phone.
 */
export interface PositionFix {
  lat: number;
  lon: number;
  /** Metres, or null when the device did not say. */
  accuracy: number | null;
  /** Epoch milliseconds of the fix itself, not of the moment we read it. */
  time: number;
}

/** What a detection stores about where it happened. */
export interface PositionStamp {
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  /** Absent on rows written before this existed, which is how they are told apart. */
  fixTime: number | null;
}

/** A fix older than this at detection time is only "approximate". */
export const STALE_FIX_MS = 60_000;
/** A fix worse than this many metres is only "approximate". */
export const COARSE_ACCURACY_M = 100;
/** iOS with Precise Location off lands around 1-3 km; the API exposes no flag for it. */
export const IMPRECISE_ACCURACY_M = 1000;
/** watchPosition options: fresh and precise, because this is what a sighting is stamped with. */
export const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 };

export type PositionWatchStatus = 'off' | 'waiting' | 'ok' | 'denied' | 'unavailable';

/** The stamp for a detection at `time`, from the newest fix (or no position at all). */
export function positionStamp(fix: PositionFix | null): PositionStamp {
  if (!fix) return { lat: null, lon: null, accuracy: null, fixTime: null };
  return { lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy, fixTime: fix.time };
}

/**
 * Is this saved position only approximate? True when the fix was already stale when the
 * detection happened, when the device gave no accuracy, or when the accuracy is poor.
 * `fixTime == null` means the row predates the fix time being stored, so its position
 * cannot be trusted either.
 */
export function isApproximate(p: Pick<PositionStamp, 'accuracy' | 'fixTime'>, detectionTime: number): boolean {
  if (p.fixTime == null) return true;
  if (p.accuracy == null || p.accuracy > COARSE_ACCURACY_M) return true;
  return detectionTime - p.fixTime > STALE_FIX_MS;
}

/** True for a row saved before the fix time was stored, whose position may be from session start. */
export function isLegacyPosition(p: Pick<PositionStamp, 'fixTime'>): boolean {
  return p.fixTime == null;
}

/** "±12 m", "approximate (±1.4 km)", "approximate". Plain words, no jargon (DESIGN_GUIDE.md §7). */
export function describeAccuracy(p: Pick<PositionStamp, 'accuracy' | 'fixTime'>, detectionTime: number): string {
  const rough = isApproximate(p, detectionTime);
  const metres = p.accuracy == null ? null : Math.round(p.accuracy);
  const reading = metres == null ? null : metres >= 1000 ? `±${(metres / 1000).toFixed(1)} km` : `±${metres} m`;
  if (!rough) return reading ?? '';
  return reading ? `approximate (${reading})` : 'approximate';
}

/** True when the accuracy looks like iOS with Precise Location switched off. */
export function looksImprecise(p: Pick<PositionStamp, 'accuracy'>): boolean {
  return p.accuracy != null && p.accuracy >= IMPRECISE_ACCURACY_M;
}

type Geo = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;

/**
 * Watches the device position while listening and stops when listening stops, so the GPS
 * is not left running. `current()` is the newest fix, or null when there is none: a
 * missing fix means a sighting is saved without a position, never with an old one.
 */
export class PositionWatch extends Emitter<{ change: PositionFix | null; status: PositionWatchStatus }> {
  private id: number | null = null;
  private fix: PositionFix | null = null;
  private statusValue: PositionWatchStatus = 'off';

  constructor(private readonly geo: Geo | null = typeof navigator === 'undefined' ? null : (navigator.geolocation ?? null)) {
    super();
  }

  current(): PositionFix | null {
    return this.fix;
  }

  status(): PositionWatchStatus {
    return this.statusValue;
  }

  get running(): boolean {
    return this.id !== null;
  }

  start(): void {
    if (this.id !== null) return;
    if (!this.geo) {
      this.setStatus('unavailable');
      return;
    }
    this.setStatus('waiting');
    this.id = this.geo.watchPosition(
      (pos) => {
        this.fix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          // Chrome and Safari both set timestamp; fall back to now if a browser does not.
          time: Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now(),
        };
        this.setStatus('ok');
        this.emit('change', this.fix);
      },
      (err) => {
        // Keep whatever fix we have for the rest of this listening session, but never
        // start a session with a position carried over from an earlier one.
        this.setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      WATCH_OPTIONS,
    );
  }

  /** Stop the watch and drop the fix, so the next session starts from a fresh one. */
  stop(): void {
    if (this.id !== null && this.geo) this.geo.clearWatch(this.id);
    this.id = null;
    this.fix = null;
    this.setStatus('off');
    this.emit('change', null);
  }

  private setStatus(s: PositionWatchStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.emit('status', s);
  }
}
