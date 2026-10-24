import { describe, expect, it } from 'vitest';
import { FakeMailer, MailError, SEND_TIMEOUT_MS, withSendTimeout, type Mail, type Mailer } from '../src/mailer.js';
import { buildTestApp, post, ORIGIN } from './helpers.js';

/** A transport whose send never settles, like an SMTP port that is firewalled. */
class HangingMailer implements Mailer {
  send(): Promise<void> {
    return new Promise(() => {});
  }
}
/** A transport that fails at once, like a rejected login or a DNS error. */
class ThrowingMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error('535 Authentication failed');
  }
}

describe('mailer: send timeout', () => {
  it('the default ceiling is well under the 30 s proxy timeout', () => {
    expect(SEND_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
  it('a hanging transport rejects with mail_timeout within the ceiling', async () => {
    const m = withSendTimeout(new HangingMailer(), 30);
    const started = Date.now();
    await expect(m.send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toMatchObject({ name: 'MailError', code: 'mail_timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it('a failing transport rejects with mail_failed and keeps the cause', async () => {
    const m = withSendTimeout(new ThrowingMailer(), 1_000);
    const err = await m.send({ to: 'a@example.com', subject: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).code).toBe('mail_failed');
    expect((err as MailError).message).toContain('535');
  });
  it('a working transport passes through unchanged', async () => {
    const inner = new FakeMailer();
    const m = withSendTimeout(inner, 1_000);
    const mail: Mail = { to: 'a@example.com', subject: 's', text: 't' };
    await expect(m.send(mail)).resolves.toBeUndefined();
    expect(inner.sent).toEqual([mail]);
  });
});

describe('login when the code email cannot be sent', () => {
  const email = 'member@example.com';
  const password = 'correct horse battery staple';

  it('answers 503 email_unavailable quickly instead of hanging', async () => {
    const t = await buildTestApp({ mailer: withSendTimeout(new HangingMailer(), 30) });
    expect((await post(t.app, '/v1/auth/signup', { email, password })).status).toBe(503); // the account exists; its code mail could not go
    const started = Date.now();
    const res = await post(t.app, '/v1/auth/login', { email, password }, { Origin: ORIGIN });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'email_unavailable' });
  });
  it('answers 503 email_unavailable when the transport fails outright', async () => {
    const t = await buildTestApp({ mailer: withSendTimeout(new ThrowingMailer()) });
    expect((await post(t.app, '/v1/auth/signup', { email, password })).status).toBe(503); // the account exists; its code mail could not go
    const res = await post(t.app, '/v1/auth/login', { email, password }, { Origin: ORIGIN });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'email_unavailable' });
  });
});
