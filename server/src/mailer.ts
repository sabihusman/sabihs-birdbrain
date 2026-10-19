import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Thrown when a mail could not be handed to the SMTP server in time. */
export class MailError extends Error {
  constructor(
    readonly code: 'mail_timeout' | 'mail_failed',
    message: string,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

/** Hard ceiling for one send, well under Nginx's 30 s proxy_read_timeout. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * Gmail SMTP with an app password. Values come from the environment; never log them.
 *
 * Explicit host/port instead of nodemailer's `service: 'gmail'` preset: the preset
 * uses port 465 (implicit TLS), which Hetzner blocks outbound by default, so every
 * send hung until the connection timed out. Port 587 with STARTTLS is Gmail's
 * documented submission port and is reachable from the server. The timeouts keep a
 * dead SMTP path from stalling a request for nodemailer's two-minute default.
 */
export function createSmtpMailer(user: string, appPassword: string, from: string): Mailer {
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user, pass: appPassword },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: 2 * SEND_TIMEOUT_MS,
  });
  return {
    async send(mail) {
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

/**
 * Wrap a mailer so that `send` settles within `ms`: a hanging transport rejects
 * with `MailError('mail_timeout')` and any other failure with `MailError('mail_failed')`.
 * The route handlers turn a MailError into a quick, clear 503 instead of letting
 * the request run into the proxy timeout.
 */
export function withSendTimeout(inner: Mailer, ms = SEND_TIMEOUT_MS): Mailer {
  return {
    async send(mail) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MailError('mail_timeout', `mail not sent within ${ms} ms`)), ms);
      });
      try {
        await Promise.race([inner.send(mail), timeout]);
      } catch (err) {
        if (err instanceof MailError) throw err;
        throw new MailError('mail_failed', err instanceof Error ? `${err.name}: ${err.message}` : 'mail send failed');
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/** Development transport: prints the mail (used only when MAIL_TRANSPORT=console). */
export function createConsoleMailer(): Mailer {
  return {
    async send(mail) {
      console.log(`[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
    },
  };
}

/** Test transport that keeps every mail in memory. */
export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
  last(to?: string): Mail | undefined {
    const list = to ? this.sent.filter((m) => m.to === to) : this.sent;
    return list[list.length - 1];
  }
}
