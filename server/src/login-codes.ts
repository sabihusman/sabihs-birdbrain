import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const MAX_CODE_ATTEMPTS = 5;

export interface Challenge {
  id: string;
  user_id: string;
  email: string;
  code_hash: string;
  session_token: string;
  attempts: number;
  expires_at: number;
}

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashCode(challengeId: string, code: string, secret: string): string {
  return createHash('sha256').update(`${challengeId}:${code}:${secret}`).digest('hex');
}

/** Store of pending second-factor challenges; each holds the session token it will release. */
export class LoginChallenges {
  constructor(
    private db: DatabaseSync,
    private secret: string,
    private ttlSeconds: number,
  ) {}

  create(userId: string, email: string, sessionToken: string, now = Date.now()): { id: string; code: string; expiresAt: number } {
    const id = randomBytes(24).toString('base64url');
    const code = generateCode();
    const expiresAt = now + this.ttlSeconds * 1000;
    this.db
      .prepare('INSERT INTO login_challenge (id, user_id, email, code_hash, session_token, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(id, userId, email, hashCode(id, code, this.secret), sessionToken, expiresAt, now);
    return { id, code, expiresAt };
  }

  /** Returns the challenge when the code is right; null otherwise (and burns the attempt). */
  verify(id: string, code: string, now = Date.now()): Challenge | null {
    const row = this.db.prepare('SELECT * FROM login_challenge WHERE id = ?').get(id) as unknown as Challenge | undefined;
    if (!row) return null;
    if (row.expires_at <= now || row.attempts >= MAX_CODE_ATTEMPTS) {
      this.discard(id);
      return null;
    }
    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(hashCode(id, code, this.secret), 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      this.db.prepare('DELETE FROM login_challenge WHERE id = ?').run(id);
      return row;
    }
    this.db.prepare('UPDATE login_challenge SET attempts = attempts + 1 WHERE id = ?').run(id);
    return null;
  }

  /** Drop a challenge and the session it guarded. */
  discard(id: string): void {
    const row = this.db.prepare('SELECT session_token FROM login_challenge WHERE id = ?').get(id) as { session_token: string } | undefined;
    if (row) this.db.prepare('DELETE FROM session WHERE token = ?').run(row.session_token);
    this.db.prepare('DELETE FROM login_challenge WHERE id = ?').run(id);
  }

  /** Expired challenges never release their session, so revoke those sessions too. */
  purgeExpired(now = Date.now()): void {
    const rows = this.db.prepare('SELECT id FROM login_challenge WHERE expires_at <= ?').all(now) as unknown as Array<{ id: string }>;
    for (const r of rows) this.discard(r.id);
  }
}
