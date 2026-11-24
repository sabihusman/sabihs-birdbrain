import type { DatabaseSync } from 'node:sqlite';
import type { SharedSpecies } from './friends.js';

/**
 * The account's bird list across devices (DECISIONS.md #139). Each signed-in device sends its whole set of birds (the
 * scientific name and the last day it was spotted there), which replaces what that device sent before. The account's
 * list is the union over its devices: a bird removed on one device stays while another device still has it, and
 * "Forget this device" takes a device's set away. Rows in `shared_species`, uploaded before this by the per-phone
 * sharing switch or by an app that has not updated yet, count as one more device, "Earlier uploads".
 *
 * Nothing else is kept: no times of day, places, counts, recordings or sightings.
 */

/** Devices one account may keep; a new one beyond this is refused until one is forgotten. */
export const MAX_DEVICES = 20;
/** The pseudo-device that stands for `shared_species`. */
export const EARLIER_DEVICE_ID = 'earlier-uploads';
export const EARLIER_DEVICE_LABEL = 'Earlier uploads';

export interface BirdDevice {
  id: string;
  label: string;
  /** Birds on it. */
  count: number;
  /** Epoch ms of its last sync; null for "Earlier uploads". */
  syncedAt: number | null;
}

export interface BirdListView {
  /** "Share my species list": true or false once chosen, null for an account that never chose. */
  sharing: boolean | null;
  /** The union, newest first. */
  species: SharedSpecies[];
  devices: BirdDevice[];
}

export class TooManyDevicesError extends Error {}

export class BirdListStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Replace one device's set; creates the device on first use. */
  sync(userId: string, deviceId: string, label: string, species: SharedSpecies[], now = Date.now()): void {
    this.transaction(() => {
      const known = this.db.prepare('SELECT 1 FROM bird_device WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
      if (!known) {
        const n = Number((this.db.prepare('SELECT count(*) AS n FROM bird_device WHERE user_id = ?').get(userId) as { n: number }).n);
        if (n >= MAX_DEVICES) throw new TooManyDevicesError('too many devices');
        this.db.prepare('INSERT INTO bird_device (user_id, device_id, label, created_at, synced_at) VALUES (?, ?, ?, ?, ?)').run(userId, deviceId, label, now, now);
      } else {
        this.db.prepare('UPDATE bird_device SET label = ?, synced_at = ? WHERE user_id = ? AND device_id = ?').run(label, now, userId, deviceId);
      }
      this.db.prepare('DELETE FROM device_bird WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
      const put = this.db.prepare('INSERT INTO device_bird (user_id, device_id, scientific, last_seen) VALUES (?, ?, ?, ?)');
      for (const s of species) put.run(userId, deviceId, s.sci, s.lastSeen);
    });
  }

  /** Take a device's birds off the account. "Earlier uploads" clears `shared_species`. False when there was nothing. */
  forget(userId: string, deviceId: string): boolean {
    if (deviceId === EARLIER_DEVICE_ID) return Number(this.db.prepare('DELETE FROM shared_species WHERE user_id = ?').run(userId).changes) > 0;
    let gone = false;
    this.transaction(() => {
      this.db.prepare('DELETE FROM device_bird WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
      gone = Number(this.db.prepare('DELETE FROM bird_device WHERE user_id = ? AND device_id = ?').run(userId, deviceId).changes) > 0;
    });
    return gone;
  }

  /** The account's list: each bird once, with the latest day any device spotted it. */
  union(userId: string): SharedSpecies[] {
    const rows = this.db
      .prepare(
        `SELECT scientific, max(last_seen) AS last_seen FROM (
           SELECT scientific, last_seen FROM device_bird WHERE user_id = ?
           UNION ALL SELECT scientific, last_seen FROM shared_species WHERE user_id = ?
         ) GROUP BY scientific ORDER BY last_seen DESC, scientific`,
      )
      .all(userId, userId) as Array<{ scientific: string; last_seen: string }>;
    return rows.map((r) => ({ sci: r.scientific, lastSeen: r.last_seen }));
  }

  devices(userId: string): BirdDevice[] {
    const rows = this.db
      .prepare('SELECT d.device_id, d.label, d.synced_at, (SELECT count(*) FROM device_bird b WHERE b.user_id = d.user_id AND b.device_id = d.device_id) AS n FROM bird_device d WHERE d.user_id = ? ORDER BY d.synced_at DESC')
      .all(userId) as Array<{ device_id: string; label: string; synced_at: number; n: number }>;
    const list: BirdDevice[] = rows.map((r) => ({ id: r.device_id, label: r.label, count: Number(r.n), syncedAt: Number(r.synced_at) }));
    const earlier = Number((this.db.prepare('SELECT count(*) AS n FROM shared_species WHERE user_id = ?').get(userId) as { n: number }).n);
    if (earlier > 0) list.push({ id: EARLIER_DEVICE_ID, label: EARLIER_DEVICE_LABEL, count: earlier, syncedAt: null });
    return list;
  }

  sharing(userId: string): boolean | null {
    const row = this.db.prepare('SELECT sharing FROM species_sharing WHERE user_id = ?').get(userId) as { sharing: number } | undefined;
    return row ? Number(row.sharing) === 1 : null;
  }

  setSharing(userId: string, on: boolean): void {
    this.db.prepare('INSERT INTO species_sharing (user_id, sharing) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET sharing = excluded.sharing').run(userId, on ? 1 : 0);
  }

  view(userId: string): BirdListView {
    return { sharing: this.sharing(userId), species: this.union(userId), devices: this.devices(userId) };
  }

  /** What friends see of this account: the union while sharing is on, else nothing. */
  sharedWithFriends(userId: string): SharedSpecies[] {
    return this.sharing(userId) === true ? this.union(userId) : [];
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
