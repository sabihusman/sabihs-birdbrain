import nodemailer from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Gmail SMTP with an app password. Values come from the environment; never log them. */
export function createSmtpMailer(user: string, appPassword: string, from: string): Mailer {
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass: appPassword } });
  return {
    async send(mail) {
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
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
