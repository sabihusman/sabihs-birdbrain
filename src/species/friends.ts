import type { ApiClient, FriendSpecies } from '../api/client';
import { isMember } from '../app/access';
import { Emitter } from '../shared/emitter';

/**
 * Friends' shared species lists for the Species tab (DECISIONS.md #44):
 * fetched from the API when a member opens the tab and online, kept in
 * memory and sessionStorage (per user id) so the tab works offline for the
 * session, and dropped on sign-out. Each friend contributes only a display
 * name and (scientific name, last-seen day) pairs; that is all the server
 * sends and all that is kept.
 */

export interface SpottedBy {
  name: string;
  /** YYYY-MM-DD, local calendar day as the friend's device saw it. */
  lastSeen: string;
}

const KEY_PREFIX = 'birdbrain.friends.v1:';

export function friendsKey(userId: string): string {
  return KEY_PREFIX + userId;
}

/** scientific name → people who spotted it, newest first, one row per person. */
export function indexFriendsSpecies(friends: readonly FriendSpecies[]): Map<string, SpottedBy[]> {
  const bySpecies = new Map<string, SpottedBy[]>();
  for (const f of friends) {
    const seen = new Set<string>();
    for (const s of f.species) {
      if (!s.sci || seen.has(s.sci)) continue; // never repeat a person
      seen.add(s.sci);
      let rows = bySpecies.get(s.sci);
      if (!rows) {
        rows = [];
        bySpecies.set(s.sci, rows);
      }
      rows.push({ name: f.displayName, lastSeen: s.lastSeen });
    }
  }
  for (const rows of bySpecies.values()) rows.sort(byNewestThenName);
  return bySpecies;
}

/** Sort order for "Spotted by" rows: most recent day first, then by name. Days are YYYY-MM-DD, so string order is date order. */
export function byNewestThenName(a: SpottedBy, b: SpottedBy): number {
  if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/** "Spotted by Alex, Sam" (names in newest-first order, at most `max` shown). */
export function describeSpottedBy(rows: readonly SpottedBy[], max = 3): string {
  if (rows.length === 0) return '';
  const names = rows.slice(0, max).map((r) => r.name);
  const rest = rows.length - names.length;
  const more = rest > 0 ? ` and ${rest} more` : '';
  return `Spotted by ${names.join(', ')}${more}`;
}

/** "Oct 12, 2026" from a YYYY-MM-DD day, without time-zone shifts (the day is read as local). */
export function fmtDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Waits between refresh attempts after a failure, in milliseconds (DECISIONS.md #64). */
export const REFRESH_BACKOFF_MS = [2_000, 8_000, 30_000] as const;

/** What to tell a member when the list could not be refreshed. */
export function describeRefreshFailure(message: string): string {
  return /\b429\b|rate/i.test(message) ? 'Friends’ birds may be out of date. Retrying…' : `Couldn’t refresh friends’ birds: ${message}`;
}

export class FriendsCache extends Emitter<{ change: Map<string, SpottedBy[]> }> {
  private index = new Map<string, SpottedBy[]>();
  private friends: FriendSpecies[] = [];
  /** Null while the last refresh succeeded; otherwise what to show the member. */
  lastError: string | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private userId: string | null = null;
  private loading: Promise<void> | null = null;
  private readonly unsub: () => void;

  constructor(
    private readonly api: ApiClient,
    private readonly storage: Storage | null = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
    private readonly online: () => boolean = () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  ) {
    super();
    this.load();
    void this.refresh();
    this.unsub = api.on('change', () => {
      this.load();
      void this.refresh();
    });
  }

  /** Available only to a signed-in approved member; empty otherwise (and after sign-out). */
  get available(): boolean {
    return isMember(this.api.user);
  }

  /** People who shared this species, newest first. */
  spottedBy(scientific: string): SpottedBy[] {
    return this.available ? (this.index.get(scientific) ?? []) : [];
  }

  /** Scientific names any friend has shared. */
  species(): ReadonlySet<string> {
    return this.available ? new Set(this.index.keys()) : new Set();
  }

  /** Friends with a shared list, for the empty-state text. */
  get friendCount(): number {
    return this.available ? this.friends.length : 0;
  }

  /**
   * Fetch when online and a member; otherwise keep what is cached. Resolves either way.
   * A failure is remembered in `lastError` (the Species tab says so) and retried with a
   * backoff, because a refused call used to leave a stale list and no explanation at all.
   */
  async refresh(): Promise<void> {
    if (!this.available || !this.online()) return;
    if (this.loading) return this.loading;
    this.clearRetry();
    this.loading = (async () => {
      try {
        const res = await this.api.friendsSpecies();
        this.retries = 0;
        this.lastError = null;
        this.set(res.friends, true);
      } catch (e) {
        // Offline or server down: the cached copy stays, but say so and try again.
        this.lastError = describeRefreshFailure((e as Error).message);
        this.scheduleRetry();
        this.emit('change', this.index);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Stop any pending retry; call when the view goes away. */
  dispose(): void {
    this.clearRetry();
    this.unsub();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(): void {
    const wait = REFRESH_BACKOFF_MS[Math.min(this.retries, REFRESH_BACKOFF_MS.length - 1)];
    this.retries += 1;
    if (this.retries > REFRESH_BACKOFF_MS.length) return; // tried enough; the next tab open retries
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refresh();
    }, wait);
  }

  private set(friends: FriendSpecies[], persist: boolean): void {
    this.friends = friends;
    this.index = indexFriendsSpecies(friends);
    if (persist && this.userId) {
      try {
        this.storage?.setItem(friendsKey(this.userId), JSON.stringify(friends));
      } catch {
        /* storage unavailable */
      }
    }
    this.emit('change', this.index);
  }

  /** Re-read the cache for the current user; a sign-out drops it, a different user never sees another's copy. */
  private load(): void {
    const prev = this.userId;
    this.userId = this.available ? this.api.user!.id : null;
    if (prev && prev !== this.userId) {
      try {
        this.storage?.removeItem(friendsKey(prev));
      } catch {
        /* ignore */
      }
    }
    if (!this.userId) {
      this.set([], false);
      return;
    }
    let cached: FriendSpecies[] = [];
    try {
      const raw = this.storage?.getItem(friendsKey(this.userId));
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) cached = parsed.filter(isFriendSpecies);
      }
    } catch {
      cached = [];
    }
    this.set(cached, false);
  }

}

function isFriendSpecies(x: unknown): x is FriendSpecies {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  return typeof f.id === 'string' && typeof f.displayName === 'string' && Array.isArray(f.species) && f.species.every((s) => s && typeof s === 'object' && typeof (s as SharedShape).sci === 'string' && typeof (s as SharedShape).lastSeen === 'string');
}
type SharedShape = { sci: unknown; lastSeen: unknown };
