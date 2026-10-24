import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Auth } from './auth.js';
import type { Mail } from './mailer.js';

/** How long a reset link works. */
export const RESET_LINK_TTL_SECONDS = 60 * 60;
/** Better Auth's identifier prefix for reset tokens; `resetPassword` looks tokens up under it. */
export const RESET_IDENTIFIER_PREFIX = 'reset-password:';

/**
 * Password reset by emailed link (DECISIONS.md #78). The token is stored the way Better Auth's
 * own `requestPasswordReset` stores it (better-auth 1.7.11, dist/api/routes/password.mjs:
 * `internalAdapter.createVerificationValue({ value: userId, identifier: "reset-password:<token>",
 * expiresAt })`), so its `resetPassword` endpoint can consume it. Hashed at rest through the
 * `verification.storeIdentifier` override in auth.ts. We build the link ourselves because the
 * Better Auth HTTP handler is not mounted and the page is a hash route in the app.
 */
export async function createResetToken(auth: Auth, userId: string, now = Date.now()): Promise<string> {
  const ctx = await auth.$context;
  const token = randomBytes(24).toString('base64url');
  await ctx.internalAdapter.createVerificationValue({ value: userId, identifier: `${RESET_IDENTIFIER_PREFIX}${token}`, expiresAt: new Date(now + RESET_LINK_TTL_SECONDS * 1000) });
  return token;
}

/** The user a live token belongs to, or null (unknown, used or expired). Does not consume it. */
export async function resetTokenUser(auth: Auth, token: string, now = Date.now()): Promise<string | null> {
  const ctx = await auth.$context;
  const v = await ctx.internalAdapter.findVerificationValue(`${RESET_IDENTIFIER_PREFIX}${token}`);
  if (!v || new Date(v.expiresAt).getTime() <= now) return null;
  return String(v.value);
}

/** A reset ends half-finished sign-ins too: their session tokens came from the old password. */
export function dropLoginChallenges(db: DatabaseSync, userId: string): void {
  db.prepare('DELETE FROM login_challenge WHERE user_id = ?').run(userId);
}

/** The page in the app; the token rides in the fragment, which browsers never send to a server. */
export function resetLink(appUrl: string, token: string): string {
  return `${appUrl}/#/reset-password?token=${encodeURIComponent(token)}`;
}

/** The reset mail, asked for by the person ("Forgot password?") or sent by Sabih from User management. */
export function resetLinkMail(to: string, link: string, by: 'self' | 'admin'): Mail {
  const minutes = Math.round(RESET_LINK_TTL_SECONDS / 60);
  const why = by === 'admin' ? 'Sabih sent you this link to choose a new password for your Sabih’s Birdbrain account.' : 'Someone, hopefully you, asked to reset the password for your Sabih’s Birdbrain account.';
  return {
    to,
    subject: 'Choose a new Birdbrain password',
    text: `${why}\n\nOpen this link to choose a new password. It works once, for ${minutes} minutes:\n${link}\n\nYour password stays the same until you use the link. If you did not ask for this, ignore this message.`,
  };
}
