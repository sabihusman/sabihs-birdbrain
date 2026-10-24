import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Open the SQLite database (WAL mode) and create the app's own tables. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_challenge (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      session_token TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_challenge_expires ON login_challenge (expires_at);
    CREATE TABLE IF NOT EXISTS ask_usage (
      day TEXT NOT NULL,
      scope TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, scope)
    );
    -- Friends (DECISIONS.md #44): invites by account, accepted pairs, and the species-only shared lists.
    CREATE TABLE IF NOT EXISTS friend_invite (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS friend_invite_to ON friend_invite (to_user_id, status);
    CREATE INDEX IF NOT EXISTS friend_invite_from ON friend_invite (from_user_id, status);
    -- a_shares: user_a's species list goes to user_b; b_shares the other way (DECISIONS.md #79).
    CREATE TABLE IF NOT EXISTS friendship (
      user_a TEXT NOT NULL,
      user_b TEXT NOT NULL,
      since INTEGER NOT NULL,
      a_shares INTEGER NOT NULL DEFAULT 1,
      b_shares INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_a, user_b)
    );
    -- Invites to an address with no account (DECISIONS.md #80): hashed token and address only.
    CREATE TABLE IF NOT EXISTS email_invite (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      email_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_by TEXT,
      share_back INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS email_invite_from ON email_invite (from_user_id, email_hash);
    CREATE INDEX IF NOT EXISTS email_invite_claimed ON email_invite (claimed_by);
    CREATE TABLE IF NOT EXISTS shared_species (
      user_id TEXT NOT NULL,
      scientific TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (user_id, scientific)
    );
    CREATE TABLE IF NOT EXISTS invite_usage (
      day TEXT NOT NULL,
      user_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, user_id)
    );
  `);
  // Databases from before DECISIONS.md #79: both directions keep sharing, as they did.
  addColumnIfMissing(db, 'friendship', 'a_shares', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing(db, 'friendship', 'b_shares', 'INTEGER NOT NULL DEFAULT 1');
  return db;
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
}

/** UTC calendar day, used as the quota bucket. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface UsageStore {
  /** Count of questions asked today by this scope ('global' or 'user:<id>'). */
  get(scope: string, now?: Date): number;
  /** Increment both the user's and the global counter. */
  record(userId: string, now?: Date): void;
}

export function createUsageStore(db: DatabaseSync): UsageStore {
  const get = db.prepare('SELECT count FROM ask_usage WHERE day = ? AND scope = ?');
  const upsert = db.prepare('INSERT INTO ask_usage (day, scope, count) VALUES (?, ?, 1) ON CONFLICT(day, scope) DO UPDATE SET count = count + 1');
  return {
    get(scope, now = new Date()) {
      const row = get.get(utcDay(now), scope) as { count: number } | undefined;
      return row ? Number(row.count) : 0;
    },
    record(userId, now = new Date()) {
      const day = utcDay(now);
      upsert.run(day, 'global');
      upsert.run(day, `user:${userId}`);
    },
  };
}
