import { MODEL_TOTAL_BYTES } from '../../model/constants';
import { el } from '../dom';

/** The one-time download, in whole MB, as the welcome and the Listen hint say it. */
export const MODEL_SIZE_MB = Math.round(MODEL_TOTAL_BYTES / 1048576);

/**
 * The welcome layer's text, in Sabih's voice (AUDIT_PROMPT "Writing style"; DECISIONS.md #68).
 * Exported so the unit test and the e2e test read the same sentences.
 */
export const WELCOME_TEXT = {
  title: 'Welcome',
  what: 'Birdbrain listens and tells you which birds are singing.',
  onDevice: `It runs on your phone; audio never leaves it. First use downloads ${MODEL_SIZE_MB} MB (Wi-Fi best).`,
  account: 'Accounts are optional: they add Ask about this bird and friends. I approve each one.',
  tabs: 'Species, Map and Recordings work without the download.',
  start: 'Start identifying',
  signIn: 'Sign in / Create account',
} as const;

export interface WelcomeHandlers {
  /** "Start identifying": remember the choice and start the download. */
  onStart: () => void;
  /** "Sign in / Create account": open Settings › Account; nothing downloads. */
  onSignIn: () => void;
}

/**
 * First-visit screen, rendered by the Listen view in place of its loading state.
 * One filled button (the main action); the sign-in button is secondary.
 */
export function welcomeCard(h: WelcomeHandlers): HTMLElement {
  const start = el('button', { class: 'btn primary big', type: 'button', 'data-testid': 'welcome-start' }, WELCOME_TEXT.start);
  const signIn = el('button', { class: 'btn', type: 'button', 'data-testid': 'welcome-signin' }, WELCOME_TEXT.signIn);
  start.addEventListener('click', () => h.onStart());
  signIn.addEventListener('click', () => h.onSignIn());
  return el(
    'section',
    { class: 'welcome', 'data-testid': 'welcome', 'aria-labelledby': 'welcome-title' },
    el('h2', { class: 'state-title', id: 'welcome-title' }, WELCOME_TEXT.title),
    el('p', null, WELCOME_TEXT.what),
    el('p', null, WELCOME_TEXT.onDevice),
    el('p', null, WELCOME_TEXT.account),
    el('div', { class: 'welcome-actions' }, start, signIn),
    el('p', { class: 'small muted' }, WELCOME_TEXT.tabs),
  );
}
