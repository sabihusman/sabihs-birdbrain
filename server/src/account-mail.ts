import type { Mail } from './mailer.js';

/**
 * Mails for creating an account (DECISIONS.md #77). Plain text, no tracking,
 * never logged. `appUrl` is the front end's first allowed origin.
 */

/** The code that finishes creating a new account. */
export function signupCodeMail(to: string, code: string, ttlMinutes: number): Mail {
  return {
    to,
    subject: 'Your Birdbrain code',
    text: `Your code to finish creating your Sabih’s Birdbrain account is ${code}\n\nIt expires in ${ttlMinutes} minutes. If you did not try to create an account, ignore this message.`,
  };
}

/**
 * Someone tried to create an account with an address that already has one and
 * did not give its password. The person creating the account sees the same
 * code screen either way, so no one learns which addresses have accounts.
 */
export function existingAccountMail(to: string, appUrl: string): Mail {
  return {
    to,
    subject: 'You already have a Birdbrain account',
    text: `Someone tried to create a Sabih’s Birdbrain account with this address, but you already have one.\n\nTo use it, sign in: ${appUrl}/#/signin\nIf you forgot your password, use “Forgot password?” on that page.\n\nIf this was not you, ignore this message. Nothing was changed.`,
  };
}

/** After the code is confirmed: the account waits for Sabih. */
export function pendingApprovalMail(to: string, appUrl: string): Mail {
  return {
    to,
    subject: 'Your Birdbrain account is waiting for approval',
    text: `Thanks for creating a Sabih’s Birdbrain account. Sabih approves each new account by hand, so yours is waiting for approval. You will get an email when it is approved.\n\nUntil then, identifying birds on your phone works as before; Ask about this bird and friends start working once you are approved.\n\nYour account: ${appUrl}/#/account`,
  };
}
