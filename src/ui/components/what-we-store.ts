import { disclosure } from './disclosure';
import { el } from '../dom';

/**
 * What the server keeps and where data goes. Written from the code, not from memory:
 * server/src/db.ts and auth.ts (tables), app.ts (what each route accepts), ask.ts /
 * natureserve.ts / ebird.ts (what leaves the server), src/storage/db.ts (what stays on
 * the device), src/geo/place-lookup.ts (what the Map tab's Places view sends to Overpass). Keep it in step with them.
 *
 * The facts are grouped so they fit a phone behind one collapsed section; nothing was
 * dropped or softened when they moved out of the single paragraph. WHAT_WE_STORE_TEXT
 * is still the whole thing in one line, built from the same groups, and the unit test
 * checks every fact against it.
 */
export interface WhatWeStoreGroup {
  title: string;
  items: string[];
}

export const WHAT_WE_STORE_GROUPS: WhatWeStoreGroup[] = [
  {
    title: 'On the server',
    items: [
      'If you create an account, the server keeps your email address and your password (hashed, so it cannot be read back).',
      'It also keeps your display name and your sign-in sessions.',
      'The 6-digit sign-in codes are kept hashed, for a few minutes.',
      'It keeps your friends and open invites, and a count of the questions you ask each day.',
    ],
  },
  {
    title: 'Only on this phone',
    items: [
      'Your sightings, recordings, clips and ticks stay on this phone only and are never uploaded.',
      // src/geo/place-lookup.ts (DECISIONS.md #72): rounded cells only, and only from the Map tab's Places view.
      'Opening Places on the Map tab sends your sightings’ positions, rounded to about 100 m, to OpenStreetMap’s Overpass service to find nearby parks and trails; nothing else is sent and nothing is stored there.',
    ],
  },
  {
    title: 'If sharing is on',
    items: [
      'The server also keeps your species list: for each bird, its scientific name and the day you last spotted it.',
      'Your friends see your display name, those species and those dates, and nothing else.',
    ],
  },
  {
    title: 'When you ask about a bird',
    items: [
      'The species name, your question and your state or province code go to the server, which looks the species up on Wikipedia and NatureServe Explorer and, with that region code, on eBird.',
      'For questions about birds near you, your position rounded to about 10 km goes to eBird too.',
      'The question and the fetched text are then sent to Ollama Cloud and, if it is busy or fails, to Google’s Gemini model; neither ever sees your name, email or exact location.',
      'Answers are kept on the server for seven days so the same question is not asked again, without your name or email.',
    ],
  },
  {
    title: 'Deleting your account',
    items: ['Deleting your account removes all of it from the server at once.', 'Copies in the nightly server backup are removed within 14 days.'],
  },
];

/** Every fact in one line, for the record and for the test that guards the wording. */
export const WHAT_WE_STORE_TEXT = WHAT_WE_STORE_GROUPS.flatMap((g) => g.items).join(' ');

/** The one-line promise on the closed row. */
export const WHAT_WE_STORE_SUMMARY = 'Sightings stay on your phone';

/**
 * The collapsed "What we store" section, closed by default: at the very bottom of
 * Settings and under the sign-up form.
 */
export function whatWeStoreFold(testId = 'what-we-store'): HTMLDetailsElement {
  return disclosure(
    { title: 'What we store', summary: WHAT_WE_STORE_SUMMARY, testId, className: 'what-we-store' },
    ...WHAT_WE_STORE_GROUPS.map((g) => el('div', { class: 'stack wws-group' }, el('h3', { class: 'wws-title' }, g.title), el('ul', { class: 'wws-list small' }, ...g.items.map((t) => el('li', null, t))))),
  );
}

/** The short line that replaces the paragraph on the sign-up form. */
export const SIGN_UP_PRIVACY_LINE = 'Your sightings stay on your phone. We store your email and a few account details.';
