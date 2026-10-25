import { describe, expect, it } from 'vitest';
import { aiServicesItem, SIGN_UP_PRIVACY_LINE, WHAT_WE_STORE_SUMMARY, whatWeStoreGroups, whatWeStoreText } from '../src/ui/components/what-we-store';

/** The server's list today (GET /v1/ai-services). */
const SERVICES = ['Ollama Cloud', 'Google Gemini'];
const WHAT_WE_STORE_GROUPS = whatWeStoreGroups(SERVICES);
const WHAT_WE_STORE_TEXT = whatWeStoreText(SERVICES);

/** The paragraph must name what the code actually stores and sends (server/src/db.ts, app.ts, ask.ts, ebird.ts). */
describe('what we store', () => {
  it('is one paragraph that covers every stored or sent item and ends with the backups sentence', () => {
    expect(WHAT_WE_STORE_TEXT).not.toContain('\n');
    for (const needle of ['email address', 'password (hashed', 'display name', 'sessions', '6-digit sign-in codes', 'friends and open invites', 'questions you ask each day', 'sightings, recordings, clips and ticks stay on this phone only', 'scientific name and the day you last spotted it', 'friends see your display name, those species and those dates, and nothing else', 'species name, your question and your state or province code', 'Wikipedia', 'NatureServe Explorer', 'eBird', 'rounded to about 10 km', 'Ollama Cloud, or Google Gemini as backup', 'none of them ever sees your name, email or exact location', 'Answers are kept on the server for seven days', 'Deleting your account removes all of it', 'rounded to about 100 m', 'Nominatim', 'centre of each 1 km area']) {
      expect(WHAT_WE_STORE_TEXT).toContain(needle);
    }
    // Since 2026-10-19 23:00 UTC a root cron job runs backup.sh nightly at 03:15 UTC with BACKUP_RETENTION_DAYS=14 (round-3 report, Backups).
    expect(WHAT_WE_STORE_TEXT.endsWith('Copies in the nightly server backup are removed within 14 days.')).toBe(true);
    // Nothing the server does not do.
    expect(WHAT_WE_STORE_TEXT).not.toMatch(/recordings are uploaded|password is stored|not stored/);
  });
});

/** The facts moved into five groups behind a collapsed section (DECISIONS.md #57); none was dropped. */
describe('what we store, regrouped', () => {
  it('has the five groups in the order the data flows', () => {
    expect(WHAT_WE_STORE_GROUPS.map((g) => g.title)).toEqual(['On the server', 'Only on this phone', 'If sharing is on', 'When you ask about a bird', 'Deleting your account']);
  });

  it('keeps every fact: the one-line paragraph is built from the groups', () => {
    expect(WHAT_WE_STORE_TEXT).toBe(WHAT_WE_STORE_GROUPS.flatMap((g) => g.items).join(' '));
    expect(WHAT_WE_STORE_GROUPS.every((g) => g.items.length > 0)).toBe(true);
    // Each bullet is one short sentence, so the groups stay readable on a phone.
    for (const g of WHAT_WE_STORE_GROUPS) for (const item of g.items) expect(item.endsWith('.')).toBe(true);
  });

  it('promises only what the app does, in the closed row and on the sign-up form', () => {
    expect(WHAT_WE_STORE_SUMMARY).toBe('Sightings stay on your phone');
    expect(SIGN_UP_PRIVACY_LINE).toBe('Your sightings stay on your phone. We store your email and a few account details.');
    // The phone-only promise must still be a fact in the groups, not only a headline.
    expect(WHAT_WE_STORE_GROUPS.find((g) => g.title === 'Only on this phone')?.items.join(' ')).toContain('never uploaded');
  });
});

/** The AI services are named from the server's list, so a provider switch needs no app change (DECISIONS.md #90). */
describe('what we store, AI services', () => {
  it('names one, two or no services in plain words', () => {
    expect(aiServicesItem(['Google Gemini'])).toBe('The question and the fetched text are then sent to Google Gemini; it never sees your name, email or exact location.');
    expect(aiServicesItem(SERVICES)).toBe('The question and the fetched text are then sent to Ollama Cloud, or Google Gemini as backup; none of them ever sees your name, email or exact location.');
    expect(aiServicesItem(null)).toBe('The question and the fetched text are then sent to an AI service; it never sees your name, email or exact location.');
  });
});
