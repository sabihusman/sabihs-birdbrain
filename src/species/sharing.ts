import type { ApiClient, SharedSpecies } from '../api/client';
import { isMember } from '../app/access';
import type { AppController } from '../app/controller';
import { listSightings } from '../storage/db';
import type { SightingRecord } from '../storage/types';

/**
 * "Share my species list with friends" (DECISIONS.md #44). Off by default;
 * the consent is a localStorage flag keyed to the user id, so it never
 * follows the session to another account. When on, the client uploads, per
 * species, only the scientific name and the local calendar day of the most
 * recent sighting: no times, no locations, no counts, no clips, no history.
 */

/** The consent text shown next to the switch; the README quotes it. */
export const SHARING_CONSENT_TEXT = 'Friends will see which birds you’ve spotted and the date you last spotted each one. Nothing else: no times, no places, no recordings, no counts. Turning this off removes the list from the server at once.';

/** Most species one upload may hold (the server enforces the same cap). */
export const MAX_SHARED_SPECIES = 2000;
/** Wait after the last change before uploading, so a burst of detections is one request. */
export const UPLOAD_DEBOUNCE_MS = 5000;

const KEY_PREFIX = 'birdbrain.share.v1:';

export function sharingKey(userId: string): string {
  return KEY_PREFIX + userId;
}

export function isSharingOn(userId: string | null | undefined, storage: Storage | null = defaultStorage()): boolean {
  if (!userId || !storage) return false;
  try {
    return storage.getItem(sharingKey(userId)) === 'on';
  } catch {
    return false;
  }
}

export function setSharingOn(userId: string, on: boolean, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    if (on) storage.setItem(sharingKey(userId), 'on');
    else storage.removeItem(sharingKey(userId));
  } catch {
    /* storage unavailable: the switch simply does not stick */
  }
}

function defaultStorage(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/** Local calendar day (YYYY-MM-DD) of an epoch-millisecond time, in the device's time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The upload: one entry per species with the day of its most recent sighting,
 * newest first, capped at MAX_SHARED_SPECIES (the oldest fall off). Pure, so
 * tests can check exactly what would leave the device.
 */
export function buildSharedSpeciesList(sightings: readonly Pick<SightingRecord, 'scientific' | 'lastTime'>[], cap = MAX_SHARED_SPECIES): SharedSpecies[] {
  const latest = new Map<string, number>();
  for (const s of sightings) {
    if (!s.scientific) continue;
    const prev = latest.get(s.scientific);
    if (prev === undefined || s.lastTime > prev) latest.set(s.scientific, s.lastTime);
  }
  return Array.from(latest, ([sci, ms]) => ({ sci, ms }))
    .sort((a, b) => b.ms - a.ms || a.sci.localeCompare(b.sci))
    .slice(0, cap)
    .map(({ sci, ms }) => ({ sci, lastSeen: localDay(ms) }));
}

/**
 * Keeps the server copy in step with the device while sharing is on: a
 * debounced upload after every `detections-changed`, on turning sharing on,
 * on sign-in and when the connection comes back. Turning sharing off clears
 * the server copy immediately. Failures are swallowed (the next change
 * retries); nothing is uploaded while signed out or not yet approved.
 */
/** Waits between upload attempts after a failure, in milliseconds (DECISIONS.md #64). */
export const UPLOAD_BACKOFF_MS = [3_000, 15_000, 60_000] as const;

export class SpeciesSharer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private dirty = false;
  private inFlight: Promise<void> | null = null;
  private readonly unsubs: Array<() => void> = [];
  /** Last outcome, for the Account card. */
  lastError: string | null = null;

  constructor(
    private readonly api: ApiClient,
    controller: Pick<AppController, 'on'>,
    private readonly storage: Storage | null = defaultStorage(),
    private readonly online: () => boolean = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  ) {
    this.unsubs.push(
      controller.on('detections-changed', () => this.schedule()),
      api.on('change', () => this.schedule()),
    );
    if (typeof window !== 'undefined') {
      const onOnline = () => this.schedule();
      window.addEventListener('online', onOnline);
      this.unsubs.push(() => window.removeEventListener('online', onOnline));
    }
    this.schedule();
  }

  get enabled(): boolean {
    return isSharingOn(this.api.user?.id, this.storage) && isMember(this.api.user);
  }

  /** Flip the consent for the signed-in user; on → upload now, off → clear the server copy now. */
  async setEnabled(on: boolean): Promise<void> {
    const user = this.api.user;
    if (!user) return;
    setSharingOn(user.id, on, this.storage);
    if (on) await this.syncNow();
    else {
      this.cancel();
      this.lastError = null;
      try {
        await this.api.clearSharedSpecies();
      } catch (e) {
        this.lastError = (e as Error).message;
        throw e;
      }
    }
  }

  /** Debounced: the upload runs UPLOAD_DEBOUNCE_MS after the last change. */
  schedule(): void {
    if (!this.enabled) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, UPLOAD_DEBOUNCE_MS);
  }

  /** Upload the full current set now (no-op when sharing is off, signed out, or offline). */
  async syncNow(): Promise<void> {
    this.cancel();
    if (!this.enabled || !this.online()) return;
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    this.dirty = false;
    this.inFlight = (async () => {
      try {
        const list = buildSharedSpeciesList(await listSightings());
        await this.api.uploadSharedSpecies(list);
        this.lastError = null;
        this.retries = 0;
      } catch (e) {
        // A refused upload (the server's rate limit, a flaky connection) used to be dropped
        // silently, so a friend simply never appeared. Say so and try again (DECISIONS.md #64).
        this.lastError = (e as Error).message;
        this.scheduleRetry();
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
    if (this.dirty) this.schedule();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Try again after a failure, a few times, with growing waits. */
  private scheduleRetry(): void {
    if (this.retries >= UPLOAD_BACKOFF_MS.length) return; // the next sighting or sign-in retries
    const wait = UPLOAD_BACKOFF_MS[this.retries];
    this.retries += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow();
    }, wait);
  }

  dispose(): void {
    this.cancel();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const u of this.unsubs.splice(0)) u();
  }
}
