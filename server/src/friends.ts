import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { utcDay } from './db.js';

/** Invites one account may send per UTC day (every call counts, so the count reveals nothing about addresses). */
export const INVITES_PER_DAY = 10;
/** Days an invite stays pending (or, once declined, blocks a repeat invite). */
export const INVITE_TTL_DAYS = 30;
/** Most species one shared list may hold; BirdNET knows about 6,500. */
export const MAX_SHARED_SPECIES = 2000;

export interface Invite {
  id: string;
  fromUserId: string;
  toUserId: string;
  status: 'pending' | 'declined';
  createdAt: number;
  expiresAt: number;
}

export interface SharedSpecies {
  sci: string;
  /** Local calendar day of the most recent sighting, YYYY-MM-DD. */
  lastSeen: string;
}

export interface FriendRow {
  id: string;
  name: string;
  since: number;
  /** Whether my species list goes to this friend (DECISIONS.md #79). */
  sharing: boolean;
}

export interface IncomingInvite {
  id: string;
  fromName: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Friend invites, accepted pairs and the species-only shared lists, all in the
 * app's own SQLite tables. Every method takes `now` so tests can move time.
 * Nothing here reads e-mail addresses: the routes resolve an address to a user
 * id once (and answer identically whether or not it exists), and from then on
 * only ids and display names travel.
 */
export class FriendsStore {
  constructor(private readonly db: DatabaseSync) {}

  // ---- invites ----------------------------------------------------------------

  /** Invites this user sent today (every attempt counts). */
  invitesToday(userId: string, now = Date.now()): number {
    const row = this.db.prepare('SELECT count FROM invite_usage WHERE day = ? AND user_id = ?').get(utcDay(new Date(now)), userId) as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  recordInviteAttempt(userId: string, now = Date.now()): void {
    this.db.prepare('INSERT INTO invite_usage (day, user_id, count) VALUES (?, ?, 1) ON CONFLICT(day, user_id) DO UPDATE SET count = count + 1').run(utcDay(new Date(now)), userId);
  }

  /** Drop invites past their expiry (pending ones and the declined ones that blocked a repeat). */
  purgeExpired(now = Date.now()): void {
    this.db.prepare('DELETE FROM friend_invite WHERE expires_at <= ?').run(now);
  }

  /** An unexpired invite between the two, in either direction, pending or declined. */
  openInviteBetween(a: string, b: string, now = Date.now()): Invite | null {
    const row = this.db.prepare('SELECT * FROM friend_invite WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)) AND expires_at > ? LIMIT 1').get(a, b, b, a, now) as Record<string, unknown> | undefined;
    return row ? toInvite(row) : null;
  }

  createInvite(fromUserId: string, toUserId: string, now = Date.now()): Invite {
    const inv: Invite = { id: randomBytes(16).toString('base64url'), fromUserId, toUserId, status: 'pending', createdAt: now, expiresAt: now + INVITE_TTL_DAYS * 86_400_000 };
    this.db.prepare('INSERT INTO friend_invite (id, from_user_id, to_user_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(inv.id, inv.fromUserId, inv.toUserId, inv.status, inv.createdAt, inv.expiresAt);
    return inv;
  }

  /** Pending, unexpired invites addressed to this user, newest first, with the inviter's display name only. */
  incomingInvites(userId: string, now = Date.now()): IncomingInvite[] {
    const rows = this.db
      .prepare("SELECT i.id, u.name AS fromName, i.created_at, i.expires_at FROM friend_invite i JOIN user u ON u.id = i.from_user_id WHERE i.to_user_id = ? AND i.status = 'pending' AND i.expires_at > ? AND u.status = 'approved' ORDER BY i.created_at DESC")
      .all(userId, now) as Array<{ id: string; fromName: string; created_at: number; expires_at: number }>;
    return rows.map((r) => ({ id: r.id, fromName: String(r.fromName ?? ''), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) }));
  }

  /** A pending, unexpired invite addressed to `userId` (the only person allowed to act on it). */
  pendingInviteFor(id: string, userId: string, now = Date.now()): Invite | null {
    const row = this.db.prepare("SELECT * FROM friend_invite WHERE id = ? AND to_user_id = ? AND status = 'pending' AND expires_at > ?").get(id, userId, now) as Record<string, unknown> | undefined;
    return row ? toInvite(row) : null;
  }

  /** Accept: the invite row goes away and the pair becomes friends. Returns false when there is nothing to accept. */
  accept(id: string, userId: string, now = Date.now()): boolean {
    const inv = this.pendingInviteFor(id, userId, now);
    if (!inv) return false;
    this.transaction(() => {
      this.db.prepare('DELETE FROM friend_invite WHERE id = ?').run(id);
      this.addFriendship(inv.fromUserId, inv.toUserId, now);
    });
    return true;
  }

  /** Decline: the row stays (as 'declined') until it expires so the same person cannot re-invite daily. */
  decline(id: string, userId: string, now = Date.now()): boolean {
    const inv = this.pendingInviteFor(id, userId, now);
    if (!inv) return false;
    this.db.prepare("UPDATE friend_invite SET status = 'declined' WHERE id = ?").run(id);
    return true;
  }

  // ---- friendships ------------------------------------------------------------

  private addFriendship(a: string, b: string, now: number): void {
    this.befriend(a, b, { firstShares: true, secondShares: true }, now);
  }

  /** Make `first` and `second` friends, with each direction's sharing set (DECISIONS.md #79, #80). */
  befriend(first: string, second: string, shares: { firstShares: boolean; secondShares: boolean }, now = Date.now()): void {
    const firstIsA = first < second;
    const [x, y] = firstIsA ? [first, second] : [second, first];
    const aShares = firstIsA ? shares.firstShares : shares.secondShares;
    const bShares = firstIsA ? shares.secondShares : shares.firstShares;
    this.db.prepare('INSERT OR IGNORE INTO friendship (user_a, user_b, since, a_shares, b_shares) VALUES (?, ?, ?, ?, ?)').run(x, y, now, aShares ? 1 : 0, bShares ? 1 : 0);
  }

  areFriends(a: string, b: string): boolean {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.db.prepare('SELECT 1 FROM friendship WHERE user_a = ? AND user_b = ?').get(x, y) !== undefined;
  }

  /** Accepted friends who are still approved members, by display name, with whether I share with each. */
  friendsOf(userId: string): FriendRow[] {
    const rows = this.db
      .prepare(
        "SELECT u.id, u.name, f.since, CASE WHEN f.user_a = ? THEN f.a_shares ELSE f.b_shares END AS sharing FROM friendship f JOIN user u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END WHERE (f.user_a = ? OR f.user_b = ?) AND u.status = 'approved' ORDER BY lower(u.name), u.id",
      )
      .all(userId, userId, userId, userId) as Array<{ id: string; name: string; since: number; sharing: number }>;
    return rows.map((r) => ({ id: r.id, name: String(r.name ?? ''), since: Number(r.since), sharing: Number(r.sharing) === 1 }));
  }

  /** Accepted, still approved friends who share their list with `userId`. */
  private sharersWith(userId: string): Array<{ id: string; name: string }> {
    return this.db
      .prepare(
        "SELECT u.id, u.name FROM friendship f JOIN user u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END WHERE ((f.user_a = ? AND f.b_shares = 1) OR (f.user_b = ? AND f.a_shares = 1)) AND u.status = 'approved' ORDER BY lower(u.name), u.id",
      )
      .all(userId, userId, userId) as Array<{ id: string; name: string }>;
  }

  /** Turn my list on or off for one friend; false when we are not friends. The other direction is theirs. */
  setSharing(userId: string, friendId: string, on: boolean): boolean {
    const [x, y] = userId < friendId ? [userId, friendId] : [friendId, userId];
    const column = userId === x ? 'a_shares' : 'b_shares';
    return this.db.prepare(`UPDATE friendship SET ${column} = ? WHERE user_a = ? AND user_b = ?`).run(on ? 1 : 0, x, y).changes > 0;
  }

  /** Remove the pair in either direction; true when a row went away. */
  removeFriend(userId: string, otherId: string): boolean {
    const [x, y] = userId < otherId ? [userId, otherId] : [otherId, userId];
    return this.db.prepare('DELETE FROM friendship WHERE user_a = ? AND user_b = ?').run(x, y).changes > 0;
  }

  // ---- shared species ---------------------------------------------------------

  /** Replace the user's whole list (an empty list clears it). */
  replaceSharedSpecies(userId: string, list: SharedSpecies[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM shared_species WHERE user_id = ?').run(userId);
      const ins = this.db.prepare('INSERT OR REPLACE INTO shared_species (user_id, scientific, last_seen) VALUES (?, ?, ?)');
      for (const s of list) ins.run(userId, s.sci, s.lastSeen);
    });
  }

  clearSharedSpecies(userId: string): void {
    this.db.prepare('DELETE FROM shared_species WHERE user_id = ?').run(userId);
  }

  sharedSpeciesOf(userId: string): SharedSpecies[] {
    const rows = this.db.prepare('SELECT scientific, last_seen FROM shared_species WHERE user_id = ? ORDER BY last_seen DESC, scientific').all(userId) as Array<{ scientific: string; last_seen: string }>;
    return rows.map((r) => ({ sci: r.scientific, lastSeen: r.last_seen }));
  }

  /** What a member may see: the display name and (sci, lastSeen) pairs of each friend who shares with them. */
  friendsSpecies(userId: string): Array<{ id: string; displayName: string; species: SharedSpecies[] }> {
    return this.sharersWith(userId).map((f) => ({ id: f.id, displayName: String(f.name ?? ''), species: this.sharedSpeciesOf(f.id) }));
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function toInvite(row: Record<string, unknown>): Invite {
  return { id: String(row.id), fromUserId: String(row.from_user_id), toUserId: String(row.to_user_id), status: row.status === 'declined' ? 'declined' : 'pending', createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
}

/** Local calendar day as the client sends it: four-digit year, real month and day, nothing else. */
export function isCalendarDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
