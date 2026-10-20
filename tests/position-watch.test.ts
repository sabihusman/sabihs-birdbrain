import { describe, expect, it, vi } from 'vitest';
import { COARSE_ACCURACY_M, describeAccuracy, isApproximate, isLegacyPosition, looksImprecise, positionStamp, PositionWatch, STALE_FIX_MS, WATCH_OPTIONS, type PositionFix } from '../src/app/position-watch';

/** A geolocation stand-in whose callbacks we drive by hand. */
function fakeGeo() {
  let success: PositionCallback | null = null;
  let failure: PositionErrorCallback | null = null;
  const cleared: number[] = [];
  let nextId = 7;
  const geo = {
    watchPosition: vi.fn((ok: PositionCallback, err?: PositionErrorCallback | null) => {
      success = ok;
      failure = err ?? null;
      return nextId++;
    }),
    clearWatch: vi.fn((id: number) => cleared.push(id)),
  };
  const push = (lat: number, lon: number, accuracy: number | null, timestamp: number) => {
    success?.({ coords: { latitude: lat, longitude: lon, accuracy: accuracy as number }, timestamp } as GeolocationPosition);
  };
  const fail = (code: number) => {
    failure?.({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: '' } as GeolocationPositionError);
  };
  return { geo, push, fail, cleared };
}

const fix = (over: Partial<PositionFix> = {}): PositionFix => ({ lat: 41.9, lon: -87.7, accuracy: 12, time: 1_000_000, ...over });

describe('position watch (DECISIONS.md #58)', () => {
  it('asks for a precise, fresh fix', () => {
    expect(WATCH_OPTIONS.enableHighAccuracy).toBe(true);
    expect(WATCH_OPTIONS.maximumAge).toBeLessThanOrEqual(5_000);
  });

  it('keeps the newest fix, so each detection is stamped with where it happened', () => {
    const { geo, push } = fakeGeo();
    const w = new PositionWatch(geo);
    expect(w.current()).toBeNull();
    w.start();
    push(41.9, -87.7, 10, 1_000);
    expect(w.current()).toEqual({ lat: 41.9, lon: -87.7, accuracy: 10, time: 1_000 });
    push(41.95, -87.72, 8, 20_000);
    expect(w.current()).toEqual({ lat: 41.95, lon: -87.72, accuracy: 8, time: 20_000 });
    // Two detections during that walk get the two different positions.
    expect(positionStamp({ lat: 41.95, lon: -87.72, accuracy: 8, time: 20_000 })).toEqual({ lat: 41.95, lon: -87.72, accuracy: 8, fixTime: 20_000 });
  });

  it('stops the watch and drops the fix when listening stops', () => {
    const { geo, cleared } = fakeGeo();
    const w = new PositionWatch(geo);
    w.start();
    expect(w.running).toBe(true);
    expect(geo.watchPosition).toHaveBeenCalledTimes(1);
    w.stop();
    expect(cleared).toEqual([7]);
    expect(w.running).toBe(false);
    expect(w.current()).toBeNull();
    expect(w.status()).toBe('off');
    // Starting again is a new watch, never a position carried over.
    w.start();
    expect(geo.watchPosition).toHaveBeenCalledTimes(2);
    expect(w.current()).toBeNull();
  });

  it('saves no location when the device refuses or has none', () => {
    const { geo, fail } = fakeGeo();
    const w = new PositionWatch(geo);
    w.start();
    fail(1);
    expect(w.status()).toBe('denied');
    expect(w.current()).toBeNull();
    expect(positionStamp(w.current())).toEqual({ lat: null, lon: null, accuracy: null, fixTime: null });
    const unavailable = new PositionWatch(null);
    unavailable.start();
    expect(unavailable.status()).toBe('unavailable');
    expect(unavailable.current()).toBeNull();
  });

  it('marks a stale or inaccurate fix approximate, and a good one not', () => {
    const good = positionStamp(fix({ accuracy: 12, time: 1_000_000 }));
    expect(isApproximate(good, 1_000_000 + 5_000)).toBe(false);
    expect(describeAccuracy(good, 1_000_000 + 5_000)).toBe('±12 m');
    // Older than a minute at detection time.
    expect(isApproximate(good, 1_000_000 + STALE_FIX_MS + 1)).toBe(true);
    expect(describeAccuracy(good, 1_000_000 + STALE_FIX_MS + 1)).toBe('approximate (±12 m)');
    // Worse than 100 m.
    const coarse = positionStamp(fix({ accuracy: COARSE_ACCURACY_M + 1 }));
    expect(isApproximate(coarse, 1_000_000)).toBe(true);
    expect(describeAccuracy(coarse, 1_000_000)).toBe('approximate (±101 m)');
    // No accuracy from the device at all.
    expect(isApproximate(positionStamp(fix({ accuracy: null })), 1_000_000)).toBe(true);
    expect(describeAccuracy(positionStamp(fix({ accuracy: null })), 1_000_000)).toBe('approximate');
  });

  it('treats a row without a fix time as approximate and from session start', () => {
    const old = { accuracy: 30, fixTime: null };
    expect(isLegacyPosition(old)).toBe(true);
    expect(isApproximate(old, Date.now())).toBe(true);
    expect(isLegacyPosition(positionStamp(fix()))).toBe(false);
  });

  it('reads a kilometre-wide fix as Precise Location being off', () => {
    expect(looksImprecise({ accuracy: 2_400 })).toBe(true);
    expect(describeAccuracy({ accuracy: 2_400, fixTime: 1_000_000 }, 1_000_000)).toBe('approximate (±2.4 km)');
    expect(looksImprecise({ accuracy: 18 })).toBe(false);
    expect(looksImprecise({ accuracy: null })).toBe(false);
  });
});
