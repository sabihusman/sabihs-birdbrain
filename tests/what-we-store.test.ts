import { describe, expect, it } from 'vitest';
import { WHAT_WE_STORE_TEXT } from '../src/ui/components/what-we-store';

/** The paragraph must name what the code actually stores and sends (server/src/db.ts, app.ts, ask.ts, ebird.ts). */
describe('what we store', () => {
  it('is one paragraph that covers every stored or sent item and ends with the (no) backups sentence', () => {
    expect(WHAT_WE_STORE_TEXT).not.toContain('\n');
    for (const needle of ['email address', 'password (hashed', 'display name', 'sessions', '6-digit sign-in codes', 'friends and open invites', 'questions you ask each day', 'sightings, recordings, clips and ticks stay on this phone only', 'scientific name and the day you last spotted it', 'friends see your display name, those species and those dates, and nothing else', 'species name, your question and your state or province code', 'Wikipedia', 'NatureServe Explorer', 'eBird', 'rounded to about 10 km', 'Ollama Cloud', 'Gemini', 'Answers are kept on the server for seven days', 'Deleting your account removes all of it']) {
      expect(WHAT_WE_STORE_TEXT).toContain(needle);
    }
    // Checked on the server 2026-10-19: backup.sh exists but no cron job or timer runs it and the backups volume is empty.
    expect(WHAT_WE_STORE_TEXT.endsWith('The server keeps no backups of this data at the moment, so nothing lingers.')).toBe(true);
    expect(WHAT_WE_STORE_TEXT).toContain('busy or fails');
    // Nothing the server does not do.
    expect(WHAT_WE_STORE_TEXT).not.toMatch(/recordings are uploaded|password is stored|not stored/);
  });
});
