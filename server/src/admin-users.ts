import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Auth } from './auth.js';

/** No look-alikes (0/O, 1/l/I): the person may have to type it from the mail. 57 symbols. */
export const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const TEMP_PASSWORD_LENGTH = 16;

/**
 * A random temporary password from `crypto.randomBytes`, without modulo bias:
 * bytes at or above the largest multiple of the alphabet size are thrown away.
 * 16 symbols from 57 is about 93 bits.
 */
export function temporaryPassword(length = TEMP_PASSWORD_LENGTH, alphabet = TEMP_PASSWORD_ALPHABET): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Set a new password for `userId` with Better Auth's own hashing and adapter,
 * then end every session and drop any half-finished sign-in codes. Mirrors
 * what the admin plugin's `setUserPassword` does (better-auth 1.7.11,
 * dist/plugins/admin/routes.mjs) without adding the plugin:
 * `ctx.password.hash` and `ctx.internalAdapter.updatePassword(userId, hash)`
 * (dist/db/internal-adapter.mjs), then `ctx.internalAdapter.deleteUserSessions`.
 * Returns false when the user has no credential (email + password) account.
 */
export async function setPasswordAndRevoke(auth: Auth, db: DatabaseSync, userId: string, password: string): Promise<boolean> {
  const ctx = await auth.$context;
  const account = await ctx.internalAdapter.findCredentialAccount(userId);
  if (!account) return false;
  const hash = await ctx.password.hash(password);
  await ctx.internalAdapter.updatePassword(userId, hash);
  await ctx.internalAdapter.deleteUserSessions(userId);
  // A pending code step holds a session token from the old password; it is dead now, so drop the row too.
  db.prepare('DELETE FROM login_challenge WHERE user_id = ?').run(userId);
  return true;
}

/** The only mail that ever carries a password; it is never logged and never returned to the admin. */
export function resetMail(to: string, password: string): { to: string; subject: string; text: string } {
  return {
    to,
    subject: 'Your Birdbrain password was reset',
    text: `Sabih reset your Birdbrain password. Your temporary password is ${password}\n\nSign in and change it in Settings → Account. You have been signed out everywhere. If you did not ask for this, reply to this message.`,
  };
}

/** Sent after a user changes their own password. */
export function passwordChangedMail(to: string): { to: string; subject: string; text: string } {
  return {
    to,
    subject: 'Your Birdbrain password was changed',
    text: 'The password for your Sabih’s Birdbrain account was changed just now, and every other device was signed out.\n\nIf you did not do this, reply to this message.',
  };
}
