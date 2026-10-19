import { describe, expect, it } from 'vitest';
import { buildAlert, MAX_ALERT_BODY_CHARS, sendAlert } from '../src/alert-mail.js';
import { FakeMailer } from '../src/mailer.js';
import { testConfig } from './helpers.js';

describe('alert mail (certificate renewal OnFailure handler)', () => {
  it('goes to ADMIN_EMAIL with a tagged, single-line subject and a bounded body', async () => {
    const config = testConfig();
    const mailer = new FakeMailer();
    await sendAlert(config, mailer, 'certificate renewal FAILED\r\non host x', 'journal line 1\njournal line 2\n');
    expect(mailer.sent.length).toBe(1);
    expect(mailer.last()).toEqual({ to: 'sabih@example.com', subject: '[Birdbrain] certificate renewal FAILED on host x', text: 'journal line 1\njournal line 2' });
    const long = buildAlert(config, 's', 'x'.repeat(MAX_ALERT_BODY_CHARS + 10));
    expect(long.text.length).toBeLessThan(MAX_ALERT_BODY_CHARS + 20);
    expect(long.text.endsWith('[truncated]')).toBe(true);
    expect(buildAlert(config, '', '   ')).toMatchObject({ subject: '[Birdbrain] Birdbrain alert', text: '(no details)' });
  });
});
