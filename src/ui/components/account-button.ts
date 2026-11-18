import type { AuthUser } from '../../api/client';
import { memberAccess } from '../../app/access';
import { el } from '../dom';

/**
 * The header's account button (Sabih's 1-B wording, Nov 18, DECISIONS.md #128), where the model pill was: signed out
 * "Sign up / Sign in" (to Create account, which links to Sign in); approved, the initial and name (to My account);
 * waiting for approval, "Waiting" (to My account, which says so).
 */
export function accountButtonContent(user: AuthUser | null | undefined): { kind: 'signed-out' | 'member' | 'waiting' | 'other'; text: string; href: string; initial: string | null; label: string } {
  if (!user) return { kind: 'signed-out', text: 'Sign up / Sign in', href: '#/signup', initial: null, label: 'Sign up or sign in' };
  const name = (user.name || '').trim() || 'Account';
  const initial = (name[0] ?? '?').toUpperCase();
  const access = memberAccess(user);
  if (access === 'member') return { kind: 'member', text: name, href: '#/account', initial, label: `My account (${name})` };
  if (access === 'pending') return { kind: 'waiting', text: 'Waiting', href: '#/account', initial, label: 'My account: waiting for approval' };
  return { kind: 'other', text: name, href: '#/settings/account', initial, label: 'Account' };
}

export function accountButton(): { el: HTMLAnchorElement; render: (user: AuthUser | null | undefined) => void } {
  const a = el('a', { class: 'account-btn', 'data-testid': 'account-button' }) as HTMLAnchorElement;
  const render = (user: AuthUser | null | undefined) => {
    const c = accountButtonContent(user);
    a.href = c.href;
    a.dataset.kind = c.kind;
    a.setAttribute('aria-label', c.label);
    a.replaceChildren(...(c.initial ? [el('span', { class: 'account-initial', 'aria-hidden': 'true' }, c.initial)] : []), el('span', { class: 'account-text' }, c.text));
  };
  return { el: a, render };
}
