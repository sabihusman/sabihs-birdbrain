/**
 * Send an operational alert to ADMIN_EMAIL with the app's own mailer.
 *
 *   node dist/alert-mail.js "<subject>" < body.txt
 *
 * Used by server/deploy/birdbrain-renew-alert.sh (systemd OnFailure= of the
 * certificate renewal unit) through `docker compose run --rm api …`, so the
 * SMTP credentials stay in /opt/birdbrain/.env and nothing else on the host
 * needs them. Exit code 0 only when the mail was handed to the transport.
 */
import { loadConfig, type Config } from './config.js';
import { createConsoleMailer, createSmtpMailer, type Mailer } from './mailer.js';

export const MAX_ALERT_BODY_CHARS = 20_000;

export function buildAlert(config: Pick<Config, 'adminEmail'>, subject: string, body: string): { to: string; subject: string; text: string } {
  const cleanSubject = subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'Birdbrain alert';
  const text = body.length > MAX_ALERT_BODY_CHARS ? `${body.slice(0, MAX_ALERT_BODY_CHARS)}\n\n[truncated]` : body;
  return { to: config.adminEmail, subject: `[Birdbrain] ${cleanSubject}`, text: text.trim() || '(no details)' };
}

export async function sendAlert(config: Pick<Config, 'adminEmail'>, mailer: Mailer, subject: string, body: string): Promise<void> {
  await mailer.send(buildAlert(config, subject, body));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const subject = process.argv[2] ?? '';
  const config = loadConfig();
  const mailer = config.MAIL_TRANSPORT === 'smtp' ? createSmtpMailer(config.SMTP_USER!, config.SMTP_APP_PASSWORD!, config.MAIL_FROM ?? `Sabih's Birdbrain <${config.SMTP_USER}>`) : createConsoleMailer();
  await sendAlert(config, mailer, subject, await readStdin());
  console.log(`[alert-mail] sent to ${config.adminEmail}`);
}

if (process.argv[1] && /alert-mail\.js$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`[alert-mail] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
