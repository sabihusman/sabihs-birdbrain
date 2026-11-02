import { audienceOf, isRunning, listed, type WhatsNewEntry } from '../../app/whats-new';
import type { View, ViewContext } from '../app';
import { openWhatsNewCards } from '../components/whats-new';
import { el } from '../dom';
import { switchRow } from '../components/rows';
import { goBack, hrefFor } from '../router';

/**
 * Settings › What's new (DECISIONS.md #112): everything announced so far, newest first, grouped as New, Fixed and
 * Coming up; an announcement that is still running can open its cards again. The switch turns the pop-ups back on
 * after "Don't show me this again". Opening the page clears the dot on the Settings row.
 */
const GROUPS: ReadonlyArray<{ kind: WhatsNewEntry['kind']; title: string }> = [
  { kind: 'new', title: 'New' },
  { kind: 'fixed', title: 'Fixed' },
  { kind: 'coming', title: 'Coming up' },
];

export function whatsNewView(ctx: ViewContext): View {
  const { whatsNew } = ctx;
  const now = new Date();
  whatsNew.markOpened(now);
  const entries = listed(now);
  const audience = audienceOf(ctx.api.user);

  const back = el('button', { class: 'btn text', type: 'button' }, '‹ Back');
  back.addEventListener('click', () => goBack('#/settings'));

  const sw = el('input', { type: 'checkbox', checked: !whatsNew.get().muted, 'data-testid': 'whats-new-popups' }) as HTMLInputElement;
  sw.addEventListener('change', () => whatsNew.setMuted(!sw.checked));
  const popups = switchRow('Show new features on Listen', sw, { hint: 'A one-line note, once per feature. Off: they only appear here.' });

  const groups = GROUPS.map((g) => {
    const items = entries.filter((e) => e.kind === g.kind);
    if (!items.length) return null;
    return el(
      'section',
      { class: 'card wn-group', 'data-testid': `whats-new-${g.kind}` },
      el('h2', null, g.title),
      ...items.map((e) => {
        const cards = audience ? e.cards?.[audience] : undefined;
        const open = cards?.length && isRunning(e, now) ? el('button', { class: 'btn small', type: 'button', 'data-testid': 'whats-new-open' }, 'See the cards ›') : null;
        open?.addEventListener('click', () =>
          openWhatsNewCards(e, audience!, {
            onMute: () => {
              whatsNew.setMuted(true);
              sw.checked = false;
            },
            onSignUp: () => (location.hash = hrefFor({ name: 'signup' })),
            onSignIn: () => (location.hash = hrefFor({ name: 'signin' })),
            onTryBirdAmp: () => {
              ctx.controller.settings.update({ listenLayout: 'birdamp' });
              location.hash = hrefFor({ name: 'listen' });
            },
          }),
        );
        return el('article', { class: 'wn-item', 'data-testid': 'whats-new-item', 'data-id': e.id }, el('h3', null, e.title), el('p', null, e.text), open);
      }),
    );
  });

  return {
    el: el('div', { class: 'stack wn-page' }, el('div', { class: 'row' }, back), el('h1', null, 'What’s new'), el('section', { class: 'card' }, popups), ...groups),
  };
}
