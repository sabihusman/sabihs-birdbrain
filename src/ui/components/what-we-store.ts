import { el } from '../dom';

/**
 * One plain paragraph about what the server keeps and where data goes, shown
 * on the sign-up form and in the Account card. Written from the code, not from
 * memory: server/src/db.ts and auth.ts (tables), app.ts (what each route
 * accepts), ask.ts / natureserve.ts / ebird.ts (what leaves the server),
 * src/storage/db.ts (what stays on the device). Keep it in step with them.
 */
export const WHAT_WE_STORE_TEXT =
  'What we store: if you create an account, the server keeps your email address, your password (hashed, so it cannot be read back), your display name, your sign-in sessions, the 6-digit sign-in codes (hashed, for a few minutes), your friends and open invites, and a count of the questions you ask each day. ' +
  'Your sightings, recordings, clips and ticks stay on this phone only and are never uploaded. ' +
  'If you turn on sharing, the server also keeps your species list: for each bird, its scientific name and the day you last spotted it; friends see your display name, those species and those dates, and nothing else. ' +
  'When you ask about a bird, the species name, your question and your state or province code go to the server, which looks the species up on Wikipedia and NatureServe Explorer and, with that region code, on eBird; for questions about birds near you, your position rounded to about 10 km goes to eBird too. ' +
  'The question and the fetched text are then sent to Ollama Cloud and, if it is busy or fails, to Google’s Gemini model; neither ever sees your name, email or exact location. ' +
  'Answers are kept on the server for seven days so the same question is not asked again, without your name or email. ' +
  'Deleting your account removes all of it from the server at once. The server keeps no backups of this data at the moment, so nothing lingers.';

export function whatWeStore(): HTMLParagraphElement {
  return el('p', { class: 'small muted', 'data-testid': 'what-we-store' }, WHAT_WE_STORE_TEXT);
}
