import { describeAiServices, refreshAiServices, storedAiServices } from '../../api/ai-services';
import { disclosure } from './disclosure';
import { el } from '../dom';

/**
 * What the server keeps and where data goes. Written from the code, not from memory:
 * server/src/db.ts and auth.ts (tables), app.ts (what each route accepts), ask.ts /
 * natureserve.ts / ebird.ts (what leaves the server), src/storage/db.ts (what stays on
 * the device), src/geo/geocode.ts (what the Map tab's Places view sends to Nominatim). Keep it in step with them.
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

/** Where a question goes, named from the server's list (DECISIONS.md #90); "an AI service" until the app has asked. */
export function aiServicesItem(services: string[] | null): string {
  const several = (services?.length ?? 0) > 1;
  return `The question and those sources go to ${describeAiServices(services)}; ${several ? 'none of them sees' : 'it never sees'} your name, email or exact location.`;
}

export function whatWeStoreGroups(services: string[] | null): WhatWeStoreGroup[] {
  return [
  {
    title: 'On the server',
    items: [
      'With an account: your email, password (hashed, unreadable), display name and sign-in sessions.',
      'Sign-in codes (hashed, for minutes), reset links (hashed, 1 hour), friends, open invites and a daily question count.',
      'Inviting someone without an account: a hashed copy of their address, up to 30 days, so they aren’t emailed twice.',
    ],
  },
  {
    title: 'Only on this phone',
    items: [
      'Sightings, recordings, clips and ticks never leave this phone.',
      // src/geo/geocode.ts (DECISIONS.md #73): rounded area centres only, and only from the Map tab's Places view.
      'Map › Places sends each 1 km area’s centre, rounded to ~100 m, to OpenStreetMap’s Nominatim for its name. Nothing else.',
    ],
  },
  {
    title: 'If sharing is on',
    items: [
      'The server keeps each bird’s name and the last day you spotted it. Friends see only that and your display name.',
    ],
  },
  {
    title: 'When you ask about a bird',
    items: [
      'The species, your question and your state/province go to the server, which looks them up on Wikipedia, NatureServe and eBird. “Near me” questions add your position, rounded to ~10 km.',
      aiServicesItem(services),
      'Answers are kept 7 days for repeat questions, without your name or email.',
    ],
  },
  {
    title: 'Deleting your account',
    items: ['Deleting your account erases it from the server at once, and from nightly backups within 14 days.'],
  },
  ];
}

/** Every fact in one line, for the record and for the test that guards the wording. */
export function whatWeStoreText(services: string[] | null): string {
  return whatWeStoreGroups(services).flatMap((g) => g.items).join(' ');
}

/** The one-line promise on the closed row. */
export const WHAT_WE_STORE_SUMMARY = 'Sightings stay on your phone';

/**
 * The collapsed "What we store" section, closed by default: at the very bottom of
 * Settings and under the sign-up form.
 */
export function whatWeStoreFold(testId = 'what-we-store'): HTMLDetailsElement {
  const stored = storedAiServices();
  const aiText = aiServicesItem(stored);
  let aiLine: HTMLElement | null = null;
  const item = (t: string) => {
    const li = el('li', t === aiText ? { 'data-testid': 'wws-ai' } : null, t);
    if (t === aiText) aiLine = li;
    return li;
  };
  return disclosure(
    {
      title: 'What we store',
      summary: WHAT_WE_STORE_SUMMARY,
      testId,
      className: 'what-we-store',
      // The server is asked which AI services it uses only when someone opens this, not on every visit.
      onToggle: (open) => {
        if (open) void refreshAiServices().then((list) => aiLine && (aiLine.textContent = aiServicesItem(list)));
      },
    },
    ...whatWeStoreGroups(stored).map((g) => el('div', { class: 'stack wws-group' }, el('h3', { class: 'wws-title' }, g.title), el('ul', { class: 'wws-list small' }, ...g.items.map(item)))),
  );
}

/** The short line that replaces the paragraph on the sign-up form. */
export const SIGN_UP_PRIVACY_LINE = 'Your sightings stay on your phone. We store your email and a few account details.';
