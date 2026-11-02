import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/**
 * "What's new" memory per account (DECISIONS.md #112): which announcements this person has already been shown, and
 * whether they turned the pop-ups off ("Don't show me this again"). The phone keeps the same record; this copy lets
 * a second phone, or a phone that cleared its storage, skip what was already seen. Ids only, no content.
 */
export const WHATS_NEW_MAX_IDS = 200;
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const whatsNewSchema = z.object({ seen: z.array(idSchema).max(WHATS_NEW_MAX_IDS).optional(), muted: z.boolean().optional() }).strict();

export interface WhatsNewState {
  seen: string[];
  muted: boolean;
}

export class WhatsNewStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whats_new_state (
        user_id TEXT PRIMARY KEY,
        seen TEXT NOT NULL DEFAULT '[]',
        muted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  get(userId: string): WhatsNewState {
    const row = this.db.prepare('SELECT seen, muted FROM whats_new_state WHERE user_id = ?').get(userId) as { seen: string; muted: number } | undefined;
    if (!row) return { seen: [], muted: false };
    let seen: string[] = [];
    try {
      const v = JSON.parse(row.seen) as unknown;
      if (Array.isArray(v)) seen = v.filter((x): x is string => typeof x === 'string');
    } catch {
      /* treat as empty */
    }
    return { seen, muted: Number(row.muted) === 1 };
  }

  /** Seen ids are added (never removed); `muted` is replaced when given. The newest ids are kept within the cap. */
  merge(userId: string, patch: { seen?: string[]; muted?: boolean }, now = Date.now()): WhatsNewState {
    const cur = this.get(userId);
    const seen = [...new Set([...cur.seen, ...(patch.seen ?? [])])].slice(-WHATS_NEW_MAX_IDS);
    const muted = patch.muted ?? cur.muted;
    this.db
      .prepare('INSERT INTO whats_new_state (user_id, seen, muted, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET seen = excluded.seen, muted = excluded.muted, updated_at = excluded.updated_at')
      .run(userId, JSON.stringify(seen), muted ? 1 : 0, now);
    return { seen, muted };
  }

  delete(userId: string): void {
    this.db.prepare('DELETE FROM whats_new_state WHERE user_id = ?').run(userId);
  }
}
