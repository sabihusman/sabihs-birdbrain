import type { Mailer } from './mailer.js';

export const SIGNUP_NOTIFY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Tells the admin when a new account has verified its e-mail and is waiting
 * for approval. At most one mail per 10 minutes: the first sign-up of a quiet
 * period is mailed at once; any that follow inside the window are held and
 * sent as one summary when the window closes (or on the next sign-up after
 * it). Only the address and the admin link go into the mail.
 */
export class SignupNotifier {
  private lastSentAt = -Infinity;
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly mailer: Mailer,
    private readonly adminEmail: string,
    private readonly adminUrl: string,
    private readonly windowMs = SIGNUP_NOTIFY_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a verified, still-pending sign-up. Resolves once any mail due now has been handed to the mailer. */
  async notify(email: string): Promise<void> {
    if (!this.pending.includes(email)) this.pending.push(email);
    await this.flushIfDue();
  }

  /** Send the held sign-ups if the window has passed; otherwise arm a timer for when it does. */
  async flushIfDue(): Promise<void> {
    if (this.pending.length === 0) return;
    const wait = this.lastSentAt + this.windowMs - this.now();
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flushIfDue();
        }, wait);
        this.timer.unref?.();
      }
      return;
    }
    const batch = this.pending.splice(0);
    this.lastSentAt = this.now();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await this.mailer.send(buildSignupMail(this.adminEmail, this.adminUrl, batch));
    } catch (err) {
      // Approval is still possible from the admin page; the failure is logged, never surfaced to the signing-up user.
      console.error(`[signup-notify] mail failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get queued(): number {
    return this.pending.length;
  }
}

export function buildSignupMail(to: string, adminUrl: string, emails: string[]): { to: string; subject: string; text: string } {
  if (emails.length === 1) {
    return { to, subject: 'New Birdbrain sign-up', text: `New Birdbrain sign-up: ${emails[0]} is waiting for approval.\n\nApprove or reject: ${adminUrl}` };
  }
  return {
    to,
    subject: `${emails.length} new Birdbrain sign-ups`,
    text: `${emails.length} new Birdbrain sign-ups are waiting for approval:\n${emails.map((e) => `  ${e}`).join('\n')}\n\nApprove or reject: ${adminUrl}`,
  };
}
