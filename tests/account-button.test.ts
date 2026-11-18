import { describe, expect, it } from 'vitest';
import { accountButtonContent } from '../src/ui/components/account-button';
import { SHARE_BANNER_KEY, shareBannerWanted } from '../src/ui/components/share-banner';
import { MemoryStorage } from './helpers/memory-storage';

const user = (status: 'approved' | 'pending' | 'disabled', name = 'Sabih') => ({ id: 'u1', email: 'sabih@example.com', name, status, role: 'member' as const });

describe('header account button (DECISIONS.md #128)', () => {
  it('signed out: "Sign up / Sign in" to Create account', () => {
    expect(accountButtonContent(null)).toMatchObject({ kind: 'signed-out', text: 'Sign up / Sign in', href: '#/signup', initial: null });
  });
  it('approved: initial and name to My account; never the email', () => {
    expect(accountButtonContent(user('approved') as never)).toMatchObject({ kind: 'member', text: 'Sabih', initial: 'S', href: '#/account' });
    const noName = accountButtonContent(user('approved', '') as never);
    expect(noName.text).toBe('Account');
    expect(JSON.stringify(noName)).not.toContain('example.com');
  });
  it('waiting for approval: "Waiting" to My account', () => {
    expect(accountButtonContent(user('pending') as never)).toMatchObject({ kind: 'waiting', text: 'Waiting', href: '#/account' });
  });
});

describe('Species share banner (DECISIONS.md #128)', () => {
  it('only signed out, until closed on this phone', () => {
    const storage = new MemoryStorage();
    expect(shareBannerWanted(null, storage)).toBe(true);
    expect(shareBannerWanted(user('approved') as never, storage)).toBe(false);
    expect(shareBannerWanted(user('pending') as never, storage)).toBe(false);
    storage.setItem(SHARE_BANNER_KEY, 'closed');
    expect(shareBannerWanted(null, storage)).toBe(false);
  });
});
