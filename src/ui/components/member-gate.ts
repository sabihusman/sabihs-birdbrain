import type { ApiClient } from '../../api/client';
import { lockedNote, memberAccess, type MemberAccess } from '../../app/access';
import { el } from '../dom';

/** The one-line "Sign in to unlock" note shown in place of a member feature (DESIGN_GUIDE.md §9). */
export function lockedNoteEl(access: Exclude<MemberAccess, 'member'>, feature: string): HTMLElement {
  return el('p', { class: 'small muted locked-note' }, lockedNote(access, feature), ' ', access === 'signed-out' ? el('a', { href: '#/signin' }, 'Sign in or create an account.') : null);
}

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
    const note = lockedNoteEl(access, feature);
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
