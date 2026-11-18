import type { AuthUser } from '../../api/client';
import { el } from '../dom';

/**
 * Species tab, signed out only (Sabih, Nov 18, DECISIONS.md #128): why an account helps, with the two ways in.
 * × hides it on this phone for good (`birdbrain.sharebanner.v1`); members and people waiting for approval never see it.
 */
export const SHARE_BANNER_KEY = 'birdbrain.sharebanner.v1';
export const SHARE_BANNER_TITLE = 'Share your birds with friends';
export const SHARE_BANNER_TEXT = 'Friends see which birds you’ve spotted, and you see theirs.';

export function shareBannerWanted(user: AuthUser | null | undefined, storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null): boolean {
  if (user) return false;
  try {
    return storage?.getItem(SHARE_BANNER_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function shareBanner(onClose: () => void): HTMLElement {
  const close = el('button', { class: 'share-banner-close', type: 'button', 'aria-label': 'Close', 'data-testid': 'share-banner-close' }, '×');
  const box = el(
    'section',
    { class: 'share-banner', 'data-testid': 'share-banner', 'aria-labelledby': 'share-banner-title' },
    el('span', { class: 'share-banner-icon', 'aria-hidden': 'true' }, '👥'),
    el(
      'div',
      null,
      el('h2', { id: 'share-banner-title' }, SHARE_BANNER_TITLE),
      el('p', null, SHARE_BANNER_TEXT),
      el('div', { class: 'share-banner-actions' }, el('a', { class: 'share-banner-primary', href: '#/signup', 'data-testid': 'share-banner-signup' }, 'Create free account'), el('a', { class: 'share-banner-link', href: '#/signin', 'data-testid': 'share-banner-signin' }, 'Sign in')),
    ),
    close,
  );
  close.addEventListener('click', () => {
    try {
      localStorage.setItem(SHARE_BANNER_KEY, 'closed');
    } catch {
      /* private mode: closed for this visit */
    }
    box.remove();
    onClose();
  });
  return box;
}
