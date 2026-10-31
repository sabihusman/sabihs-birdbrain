import { describe, expect, it } from 'vitest';
import { goBack, noteInAppNavigation, resetInAppNavigationForTest } from '../src/ui/router';

describe('‹ Back on the account pages (UI/UX audit finding 8)', () => {
  it('goes back inside the app, or to the fallback when the page was opened directly', () => {
    resetInAppNavigationForTest();
    let backs = 0;
    const loc = { hash: '#/signin' };
    goBack('#/settings/account', { back: () => backs++ }, loc);
    expect(backs).toBe(0);
    expect(loc.hash).toBe('#/settings/account');
    noteInAppNavigation();
    goBack('#/settings/account', { back: () => backs++ }, loc);
    expect(backs).toBe(1);
    resetInAppNavigationForTest();
  });
});
