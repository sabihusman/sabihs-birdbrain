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
