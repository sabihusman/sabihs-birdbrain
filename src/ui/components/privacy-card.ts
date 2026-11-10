import type { SettingsStore } from '../../app/settings';
import type { UsageCounts } from '../../app/usage-counts';
import { el } from '../dom';
import { switchRow } from './rows';

/**
 * Settings › Privacy (DECISIONS.md #120): the switch for the anonymous usage counts, what they are, and the
 * line Sabih asked for in plain sight: what is never sent. The same words feed "What we store".
 */
export const USAGE_NEVER_SENT = 'Never sent: audio, GPS position, bird names, your email or what members ask.';

/** What the counts are, one short sentence each (src/app/usage-counts.ts SCHEMA and buildPayload). */
export const USAGE_SENT_ITEMS: readonly string[] = [
  'Which screens are opened, by name only (like “Map”).',
  'When listening starts and stops, for how long, and how many birds it found (not which).',
  'The Listen layout, how the phone ran the model and how long it took to load.',
  'Microphone and model problems.',
  'Browser, type of device, screen width and time zone.',
];

export const USAGE_WHERE =
  'They go to PostHog, a US analytics service. Nothing is saved on your phone for this. PostHog uses your IP address and browser to make an anonymous count that changes every day, then throws both away.';

export function usageHint(usage: Pick<UsageCounts, 'configured' | 'blockedByBrowser'>): string {
  if (!usage.configured) return 'Not switched on in this version of the app, so nothing is sent.';
  if (usage.blockedByBrowser) return 'Off, because your browser asks websites not to track you.';
  return 'Helps Sabih see what gets used and what breaks.';
}

export function privacyCard(settings: SettingsStore, usage: Pick<UsageCounts, 'configured' | 'blockedByBrowser'>): HTMLElement {
  const locked = !usage.configured || usage.blockedByBrowser;
  const input = el('input', { type: 'checkbox', checked: !locked && settings.get().usageCounts, disabled: locked, 'data-testid': 'usage-switch' }) as HTMLInputElement;
  input.addEventListener('change', () => settings.update({ usageCounts: input.checked }));
  const row = switchRow('Anonymous usage counts', input, {
    hint: usageHint(usage),
    more: [el('p', null, 'What’s sent:'), el('ul', { class: 'wws-list small' }, ...USAGE_SENT_ITEMS.map((t) => el('li', null, t))), el('p', { class: 'small' }, USAGE_WHERE)],
    foldTestId: 'usage-whats-sent',
  });
  return el('section', { class: 'card', 'data-testid': 'privacy' }, el('h2', null, 'Privacy'), row, el('p', { class: 'small', 'data-testid': 'usage-never-sent' }, USAGE_NEVER_SENT));
}
