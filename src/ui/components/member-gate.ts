import type { ApiClient } from '../../api/client';
import { lockedNote, memberAccess } from '../../app/access';
import { el } from '../dom';

export interface Gated {
  el: HTMLElement;
  dispose?: () => void;
}

/**
 * Renders `build()` for approved members and a one-line "Sign in to unlock"
 * note for everyone else. Re-renders when the cached session changes (sign in,
 * approval refresh, sign out). Decided from api.user only, so it works offline.
 */
export function memberGate(api: ApiClient, feature: string, build: () => Gated, opts: { testId?: string; wrap?: boolean } = {}): { el: HTMLElement; dispose: () => void } {
  const root = el('div', { 'data-testid': opts.testId ?? 'member-gate' });
  let inner: Gated | null = null;
  const render = () => {
    inner?.dispose?.();
    inner = null;
    const access = memberAccess(api.user);
    if (access === 'member') {
      inner = build();
      root.replaceChildren(inner.el);
      root.dataset.access = 'member';
      return;
    }
    root.dataset.access = access;
    const note = el('p', { class: 'small muted locked-note' }, lockedNote(access, feature), ' ', access === 'signed-out' ? el('a', { href: '#/settings' }, 'Sign in or create an account in Settings.') : null);
    root.replaceChildren(opts.wrap === false ? note : el('section', { class: 'card' }, note));
  };
  render();
  const unsub = api.on('change', render);
  return {
    el: root,
    dispose() {
      unsub();
      inner?.dispose?.();
    },
  };
}
