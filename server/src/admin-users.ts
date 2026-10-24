/**
 * Mails for the admin's user management (DECISIONS.md #61). The reset itself moved to an
 * emailed link (src/password-reset.ts, DECISIONS.md #78); no password is ever mailed now.
 */

/** Sent after a password change: from Change password (other devices signed out) or a reset link (all of them). */
export function passwordChangedMail(to: string, how: 'change' | 'reset' = 'change'): { to: string; subject: string; text: string } {
  const out = how === 'reset' ? 'you were signed out on every device' : 'every other device was signed out';
  return {
    to,
    subject: 'Your Birdbrain password was changed',
    text: `The password for your Sabih’s Birdbrain account was changed just now, and ${out}.\n\nIf you did not do this, reply to this message.`,
  };
}
