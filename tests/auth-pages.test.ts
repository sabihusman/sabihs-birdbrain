import { describe, expect, it } from 'vitest';
import { hrefFor, parseHash } from '../src/ui/router';
import { AUTH_TEXT, codeSentText } from '../src/ui/views/auth';

describe('Sign in and Create account pages (DECISIONS.md #77)', () => {
  it('have their own routes, which round-trip', () => {
    expect(parseHash('#/signin')).toEqual({ name: 'signin' });
    expect(parseHash('#/signup')).toEqual({ name: 'signup' });
    expect(hrefFor({ name: 'signin' })).toBe('#/signin');
    expect(hrefFor({ name: 'signup' })).toBe('#/signup');
  });

  it('the reset link carries its token in the fragment and round-trips (DECISIONS.md #78)', () => {
    expect(parseHash('#/forgot-password')).toEqual({ name: 'forgot-password' });
    expect(parseHash('#/reset-password?token=abc_DEF-123')).toEqual({ name: 'reset-password', token: 'abc_DEF-123' });
    expect(parseHash('#/reset-password')).toEqual({ name: 'reset-password', token: '' });
    expect(hrefFor({ name: 'reset-password', token: 'a b' })).toBe('#/reset-password?token=a%20b');
    expect(parseHash(hrefFor({ name: 'reset-password', token: 'a b/c' }))).toEqual({ name: 'reset-password', token: 'a b/c' });
    // Other routes ignore a query.
    expect(parseHash('#/signin?x=1')).toEqual({ name: 'signin' });
  });

  it('say where the code went, why, and for how long', () => {
    expect(codeSentText('a@b.co', 600, 'sign-in')).toBe('We emailed a 6-digit code to a@b.co. It expires in 10 minutes.');
    expect(codeSentText('a@b.co', 600, 'sign-up')).toBe('We emailed a 6-digit code to a@b.co. Enter it to finish creating your account. It expires in 10 minutes.');
    expect(codeSentText('a@b.co', 50, 'sign-in')).toBe('We emailed a 6-digit code to a@b.co. It expires in 1 minute.');
  });

  it('tell a new account it waits for approval, in plain words', () => {
    expect(AUTH_TEXT.pending).toContain('approves each new account by hand');
    expect(AUTH_TEXT.pending).toContain('you will get an email when yours is approved');
    expect(AUTH_TEXT.pendingMeanwhile).toBe('Until then, listening and identifying birds work as before.');
  });
});

describe('invite links (DECISIONS.md #80)', () => {
  it('carry their token to Create account and round-trip', async () => {
    const { hrefFor: href, parseHash: parse } = await import('../src/ui/router');
    expect(parse('#/signup?invite=abc_DEF-123')).toEqual({ name: 'signup', invite: 'abc_DEF-123' });
    expect(parse('#/signup')).toEqual({ name: 'signup' });
    expect(href({ name: 'signup', invite: 'a/b' })).toBe('#/signup?invite=a%2Fb');
    expect(parse(href({ name: 'signup', invite: 'a/b' }))).toEqual({ name: 'signup', invite: 'a/b' });
  });

  it('say who invited them and ask before sharing back', async () => {
    const { inviteIntro, shareBackLabel } = await import('../src/ui/views/auth');
    expect(inviteIntro('Alex')).toBe('Alex invited you. Once Sabih approves your account, you and Alex become friends, and you see which birds Alex has spotted and the day they last spotted each one.');
    expect(shareBackLabel('Alex')).toBe('Also share which birds I’ve spotted, and the day I last spotted each one, with Alex');
  });

  it('never turn "Share my species list" on by themselves', async () => {
    const { inviteShareNote } = await import('../src/ui/components/friends-panel');
    expect(inviteShareNote(true)).toContain('Sending an invite also shares your species list with them once you are friends.');
    expect(inviteShareNote(false)).toBe('Your species list is not shared with anyone. Turn on “Share my species list” above if you want new friends to see it.');
  });
});
