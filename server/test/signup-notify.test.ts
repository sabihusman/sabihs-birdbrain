import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeMailer } from '../src/mailer.js';
import { buildSignupMail, SIGNUP_NOTIFY_WINDOW_MS, SignupNotifier } from '../src/signup-notify.js';
import { ADMIN, buildTestApp, ORIGIN, signUpAndLogin } from './helpers.js';

afterEach(() => vi.useRealTimers());

describe('sign-up notification to the admin', () => {
  it('mails the first sign-up at once with only the address and the admin link', async () => {
    const mailer = new FakeMailer();
    let t = 1_000_000;
    const n = new SignupNotifier(mailer, 'admin@example.com', 'https://app.example/#/admin', SIGNUP_NOTIFY_WINDOW_MS, () => t);
    await n.notify('new@example.com');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toEqual({ to: 'admin@example.com', subject: 'New Birdbrain sign-up', text: 'New Birdbrain sign-up: new@example.com is waiting for approval.\n\nApprove or reject: https://app.example/#/admin' });
    // a burst inside the window is held
    t += 1000;
    await n.notify('spam1@example.com');
    await n.notify('spam2@example.com');
    await n.notify('spam2@example.com');
    expect(mailer.sent).toHaveLength(1);
    expect(n.queued).toBe(2);
    // after the window, one summary with the held addresses
    t += SIGNUP_NOTIFY_WINDOW_MS;
    await n.flushIfDue();
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1].subject).toBe('2 new Birdbrain sign-ups');
    expect(mailer.sent[1].text).toContain('  spam1@example.com\n  spam2@example.com');
    expect(mailer.sent[1].text).not.toContain('new@example.com');
    expect(n.queued).toBe(0);
  });

  it('a timer sends the held summary when the window closes, even with no further sign-ups', async () => {
    vi.useFakeTimers();
    const mailer = new FakeMailer();
    const n = new SignupNotifier(mailer, 'admin@example.com', 'u', 1000, () => Date.now());
    await n.notify('a@example.com');
    await n.notify('b@example.com');
    expect(mailer.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[1].text).toContain('b@example.com');
  });

  it('a failing mailer never breaks the sign-up', async () => {
    const n = new SignupNotifier({ send: async () => { throw new Error('smtp down'); } }, 'admin@example.com', 'u', 1000, () => 0);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(n.notify('a@example.com')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('wording of the single and summary mails', () => {
    expect(buildSignupMail('a', 'u', ['x@example.com']).text).toMatch(/^New Birdbrain sign-up: x@example.com is waiting for approval\./);
    expect(buildSignupMail('a', 'u', ['x@example.com', 'y@example.com']).subject).toBe('2 new Birdbrain sign-ups');
  });

  it('through the API: the first verified sign-up mails the admin; the admin and re-logins do not; bursts are summarised', async () => {
    let now = Date.UTC(2026, 9, 19, 12);
    const t = await buildTestApp({ limits: { ipPerWindow: 1000, emailPerWindow: 1000 }, now: () => now });
    const adminMails = () => t.mailer.sent.filter((m) => m.to === ADMIN && /sign-up/.test(m.subject));
    await signUpAndLogin(t, ADMIN); // the admin's own account is approved at creation: no notification
    expect(adminMails()).toHaveLength(0);
    await signUpAndLogin(t, 'first@example.com');
    expect(adminMails()).toHaveLength(1);
    expect(adminMails()[0].text).toBe(`New Birdbrain sign-up: first@example.com is waiting for approval.\n\nApprove or reject: ${ORIGIN}/#/admin`);
    expect(adminMails()[0].text).not.toMatch(/password|name:|id:/i);
    // the same user logging in again is not a new sign-up
    await signUpAndLogin(t, 'first@example.com');
    expect(adminMails()).toHaveLength(1);
    // five more inside ten minutes: nothing yet
    for (let i = 0; i < 5; i++) await signUpAndLogin(t, `burst${i}@example.com`);
    expect(adminMails()).toHaveLength(1);
    // the next verification after the window delivers one summary
    now += SIGNUP_NOTIFY_WINDOW_MS + 1;
    await signUpAndLogin(t, 'later@example.com');
    expect(adminMails()).toHaveLength(2);
    expect(adminMails()[1].subject).toBe('6 new Birdbrain sign-ups');
    expect(adminMails()[1].text.match(/@example\.com/g)).toHaveLength(6);
  });
});
