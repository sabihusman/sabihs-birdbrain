import { MODEL_TOTAL_BYTES } from '../../model/constants';
import songThrushUrl from '../../assets/welcome-song-thrush.jpg';
import { el } from '../dom';

/** The one-time download, in whole MB, as the welcome and the Listen hint say it. */
export const MODEL_SIZE_MB = Math.round(MODEL_TOTAL_BYTES / 1048576);

/**
 * The welcome layer's text, from the welcome-screen mockup Sabih chose (DECISIONS.md #68, #94).
 * Exported so the unit test and the e2e test read the same sentences.
 */
export const WELCOME_TEXT = {
  title: 'Who’s singing out there?',
  pitch: 'Birdbrain listens and tells you which birds are singing. It runs on your phone, so your audio never leaves it.',
  features: [
    { strong: 'Identifies birds by sound', rest: ', live, and shows you why it thinks so.' },
    { strong: 'Private by design.', rest: ` Listening works with no account and no signal, once the ${MODEL_SIZE_MB} MB bird model is downloaded.` },
    { strong: 'An account is optional.', rest: ' It adds Ask about this bird and sharing your sightings with friends.' },
  ],
  // The button downloads the model and opens Listen; listening itself starts with the next tap there
  // (iOS only lets audio start from a tap), so it doesn't promise to start listening.
  start: 'Start identifying',
  signIn: 'Sign in',
  signUp: 'Create account',
  fine: 'Free, no ads. New accounts are approved by Sabih, so signup can take a little while; listening never waits for it.',
} as const;

/** The photo is bundled (no request before the visitor chooses) and credited under the licence's terms. */
export const WELCOME_PHOTO = {
  src: songThrushUrl,
  alt: 'A song thrush standing on a mossy stump',
  credit: 'Song thrush: Dion Art, CC BY-SA 4.0',
  creditUrl: 'https://commons.wikimedia.org/wiki/File:%D0%9F%D0%B5%D0%B2%D1%87%D0%B8%D0%B9_%D0%B4%D1%80%D0%BE%D0%B7%D0%B4_%D0%BD%D0%B0_%D0%BF%D0%B5%D0%BD%D1%8C%D0%BA%D0%B5_(Turdus_philomelos),_%D0%91%D0%B8%D1%82%D1%86%D0%B5%D0%B2%D1%81%D0%BA%D0%B8%D0%B9_%D0%BB%D0%B5%D1%81.jpg',
} as const;

/** The mockup's three line icons (microphone, shield with tick, person), coloured by CSS. */
const ICONS = [
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10m0 0a4 4 0 0 0 4-4M12 13a4 4 0 0 1-4-4m4 8v4M8 21h8"/><rect x="9" y="3" width="6" height="11" rx="3"/></svg>',
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-4.6-9-10V5l9-3 9 3v6c-2 5.4-9 10-9 10z"/><path d="M9 12l2 2 4-4"/></svg>',
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/></svg>',
];

export interface WelcomeHandlers {
  /** "Start identifying": remember the choice and start the download. */
  onStart: () => void;
  /** "Sign in": the sign-in page; nothing downloads. */
  onSignIn: () => void;
  /** "Create account": the create-account page; nothing downloads. */
  onSignUp: () => void;
}

/**
 * First-visit screen, rendered by the Listen view in place of its loading state.
 * One filled button (the main action); Sign in and Create account sit side by side under it.
 */
export function welcomeCard(h: WelcomeHandlers): HTMLElement {
  const start = el('button', { class: 'btn primary big', type: 'button', 'data-testid': 'welcome-start' }, WELCOME_TEXT.start);
  const signIn = el('button', { class: 'btn', type: 'button', 'data-testid': 'welcome-signin' }, WELCOME_TEXT.signIn);
  const signUp = el('button', { class: 'btn', type: 'button', 'data-testid': 'welcome-signup' }, WELCOME_TEXT.signUp);
  start.addEventListener('click', () => h.onStart());
  signIn.addEventListener('click', () => h.onSignIn());
  signUp.addEventListener('click', () => h.onSignUp());
  const features = el(
    'ul',
    { class: 'welcome-features' },
    ...WELCOME_TEXT.features.map((f, i) => {
      const icon = el('span', { class: 'welcome-icon' });
      icon.innerHTML = ICONS[i];
      return el('li', null, icon, el('span', null, el('strong', null, f.strong), f.rest));
    }),
  );
  return el(
    'section',
    { class: 'welcome', 'data-testid': 'welcome', 'aria-labelledby': 'welcome-title' },
    el(
      'figure',
      { class: 'welcome-photo' },
      el('img', { src: WELCOME_PHOTO.src, alt: WELCOME_PHOTO.alt, width: '720', height: '327', decoding: 'async' }),
      el('figcaption', null, el('a', { href: WELCOME_PHOTO.creditUrl, target: '_blank', rel: 'noopener' }, WELCOME_PHOTO.credit)),
    ),
    el('h2', { class: 'state-title welcome-title', id: 'welcome-title' }, WELCOME_TEXT.title),
    el('p', { class: 'welcome-pitch' }, WELCOME_TEXT.pitch),
    features,
    el('div', { class: 'welcome-actions' }, start, el('div', { class: 'welcome-account' }, signIn, signUp)),
    el('p', { class: 'small muted welcome-fine' }, WELCOME_TEXT.fine),
  );
}
