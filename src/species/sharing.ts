import type { ApiClient, BirdDevice, BirdListView, SharedSpecies } from '../api/client';
import { isMember } from '../app/access';
import type { AppController } from '../app/controller';
import { Emitter } from '../shared/emitter';
import { listSightings } from '../storage/db';
import type { SightingRecord } from '../storage/types';
import { deviceId, deviceLabel } from './device';

/**
 * The account's bird list across devices, and "Share my species list" (DECISIONS.md #44, #127, #139).
 *
 * For every signed-in member, each device sends its whole set of birds: per bird only the scientific name and the
 * local calendar day it was last spotted on that device (no times, no places, no counts, no clips, no history). The
 * set replaces what the device sent before, so a bird removed or deleted here leaves this device's set; the account's
 * list is the union over its devices, so it stays while another device still has it. "Forget this device" on My
 * account takes a device's set away. Friends see the account's list only while sharing is on; turning it off hides
 * it from them and keeps the list.
 */

/** The consent text shown next to the switch; the README quotes it. */
export const SHARING_CONSENT_TEXT = 'Friends will see which birds you’ve spotted on any of your devices and the date you last spotted each one. Nothing else: no times, no places, no recordings, no counts. Turning this off hides the list from them at once.';

/** Most species one device may send (the server enforces the same cap). */
export const MAX_SHARED_SPECIES = 2000;
/** Wait after the last change before sending, so a burst of detections is one request. */
export const UPLOAD_DEBOUNCE_MS = 5000;
/** Waits between attempts after a failure, in milliseconds (DECISIONS.md #64). */
export const UPLOAD_BACKOFF_MS = [3_000, 15_000, 60_000] as const;

const KEY_PREFIX = 'birdbrain.share.v1:';
const LIST_PREFIX = 'birdbrain.birds.v1:';

/**
 * Before #139 the sharing switch lived on each phone; it is kept only as a wish to carry to the server: an account
 * that never chose, on a phone where the switch was on (or where "share with the person who invited me" was ticked at
 * sign-up), turns sharing on at its first sync, and the phone's flag is then dropped.
 */
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
    /* storage unavailable: the wish simply does not stick */
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
 * This device's set: one entry per species with the day of its most recent sighting, newest first, capped at
 * MAX_SHARED_SPECIES (the oldest fall off). Pure, so tests can check exactly what would leave the device.
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

function readCached(userId: string, storage: Storage | null): BirdListView | null {
  try {
    const raw = storage?.getItem(LIST_PREFIX + userId);
    const v = raw ? (JSON.parse(raw) as BirdListView) : null;
    return v && Array.isArray(v.species) && Array.isArray(v.devices) ? v : null;
  } catch {
    return null;
  }
}

function writeCached(userId: string, view: BirdListView | null, storage: Storage | null): void {
  try {
    if (view) storage?.setItem(LIST_PREFIX + userId, JSON.stringify(view));
    else storage?.removeItem(LIST_PREFIX + userId);
  } catch {
    /* storage full: the list is fetched again next time */
  }
}

/**
 * Keeps this device's set on the server and the account's list here: a debounced sync after every
 * `detections-changed`, at start, on sign-in and when the connection comes back. Failures are kept for the Account
 * card and retried a few times (#64). Members only; nothing is sent while signed out, waiting for approval or offline.
 * The last list is kept per account in localStorage, so ticks from other devices show offline too.
 */
export class SpeciesSharer extends Emitter<{ change: undefined }> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private dirty = false;
  private inFlight: Promise<void> | null = null;
  private readonly unsubs: Array<() => void> = [];
  private view: BirdListView | null = null;
  private viewFor: string | null = null;
  /** Last outcome, for the Account card. */
  lastError: string | null = null;
  readonly deviceId: string;

  constructor(
    private readonly api: ApiClient,
    controller: Pick<AppController, 'on'>,
    private readonly storage: Storage | null = defaultStorage(),
    private readonly online: () => boolean = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  ) {
    super();
    this.deviceId = deviceId(storage);
    this.unsubs.push(
      controller.on('detections-changed', () => this.schedule()),
      api.on('change', () => {
        this.loadCached();
        this.emit('change', undefined);
        this.schedule();
      }),
    );
    if (typeof window !== 'undefined') {
      const onOnline = () => this.schedule();
      window.addEventListener('online', onOnline);
      this.unsubs.push(() => window.removeEventListener('online', onOnline));
    }
    this.loadCached();
    this.schedule();
  }

  /** The account list is kept for approved members (sharing is a member feature). */
  get member(): boolean {
    return isMember(this.api.user);
  }

  /** "Share my species list" is on for the account. */
  get enabled(): boolean {
    return this.member && this.current()?.sharing === true;
  }

  /** The account's birds (scientific name → last day spotted on any device); empty when signed out. */
  accountBirds(): ReadonlyMap<string, string> {
    return new Map((this.member ? (this.current()?.species ?? []) : []).map((s) => [s.sci, s.lastSeen]));
  }

  /** The account's devices, this one first. */
  devices(): BirdDevice[] {
    const list = this.member ? (this.current()?.devices ?? []) : [];
    return [...list.filter((d) => d.id === this.deviceId), ...list.filter((d) => d.id !== this.deviceId)];
  }

  /** Turn sharing on or off for the whole account. */
  async setEnabled(on: boolean): Promise<void> {
    const user = this.api.user;
    if (!user) return;
    this.lastError = null;
    try {
      this.setView(await this.api.setSpeciesSharing(on));
      setSharingOn(user.id, false, this.storage); // the account has chosen; the phone's old flag is done
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  /** "Forget this device" (another one): its birds leave the account's list. */
  async forgetDevice(id: string): Promise<void> {
    this.setView(await this.api.forgetDevice(id));
  }

  /** Debounced: the sync runs UPLOAD_DEBOUNCE_MS after the last change. */
  schedule(): void {
    if (!this.member) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, UPLOAD_DEBOUNCE_MS);
  }

  /** Send this device's whole set now (no-op when not a member, or offline). */
  async syncNow(): Promise<void> {
    this.cancel();
    if (!this.member || !this.online()) return;
    if (this.inFlight) {
      this.dirty = true;
      return this.inFlight;
    }
    this.dirty = false;
    this.inFlight = (async () => {
      try {
        const user = this.api.user!;
        const list = buildSharedSpeciesList(await listSightings());
        let view = await this.api.syncBirds(this.deviceId, deviceLabel(), list);
        // Carry a wish to share from before #139 (or from sign-up) to an account that never chose.
        if (view.sharing === null && isSharingOn(user.id, this.storage)) view = await this.api.setSpeciesSharing(true);
        if (view.sharing !== null) setSharingOn(user.id, false, this.storage);
        this.setView(view);
        this.lastError = null;
        this.retries = 0;
      } catch (e) {
        // A refused sync (the server's rate limit, a flaky connection) is said and tried again (DECISIONS.md #64).
        this.lastError = (e as Error).message;
        this.scheduleRetry();
        this.emit('change', undefined);
      } finally {
        this.inFlight = null;
      }
    })();
    await this.inFlight;
    if (this.dirty) this.schedule();
  }

  private current(): BirdListView | null {
    return this.viewFor === this.api.user?.id ? this.view : null;
  }

  private loadCached(): void {
    const id = this.api.user?.id ?? null;
    this.viewFor = id;
    this.view = id ? readCached(id, this.storage) : null;
  }

  private setView(view: BirdListView): void {
    const id = this.api.user?.id;
    if (!id) return;
    this.view = view;
    this.viewFor = id;
    writeCached(id, view, this.storage);
    this.emit('change', undefined);
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
    this.clear();
  }
}
