import type { DatabaseSync } from 'node:sqlite';
import type { AppUser, UserStatus } from './auth.js';
import { toAppUser } from './auth.js';

/** Direct reads and writes on Better Auth's user/session tables for admin and status work. */
export class Users {
  constructor(private db: DatabaseSync) {}

  list(): AppUser[] {
    const rows = this.db.prepare('SELECT id, email, name, emailVerified, status, role, createdAt FROM user ORDER BY createdAt DESC').all() as Record<string, unknown>[];
    return rows.map(toAppUser);
  }

  get(id: string): AppUser | null {
    const row = this.db.prepare('SELECT id, email, name, emailVerified, status, role, createdAt FROM user WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toAppUser(row) : null;
  }

  /** Case-insensitive lookup; signup stores the lower-cased address, older rows may not. */
  getByEmail(email: string): AppUser | null {
    const row = this.db.prepare('SELECT id, email, name, emailVerified, status, role, createdAt FROM user WHERE lower(email) = lower(?)').get(email) as Record<string, unknown> | undefined;
    return row ? toAppUser(row) : null;
  }

  setName(id: string, name: string): boolean {
    return this.db.prepare('UPDATE user SET name = ?, updatedAt = ? WHERE id = ?').run(name, new Date().toISOString(), id).changes > 0;
  }

  setStatus(id: string, status: UserStatus): boolean {
    const r = this.db.prepare('UPDATE user SET status = ?, updatedAt = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    if (status !== 'approved') this.revokeSessions(id);
    return r.changes > 0;
  }

  markEmailVerified(id: string): void {
    this.db.prepare('UPDATE user SET emailVerified = 1 WHERE id = ?').run(id);
  }

  revokeSessions(userId: string): void {
    this.db.prepare('DELETE FROM session WHERE userId = ?').run(userId);
  }

  sessionExpiry(token: string): Date | null {
    const row = this.db.prepare('SELECT expiresAt FROM session WHERE token = ?').get(token) as { expiresAt: unknown } | undefined;
    if (!row) return null;
    const v = row.expiresAt;
    return typeof v === 'number' ? new Date(v) : new Date(String(v));
  }
}
