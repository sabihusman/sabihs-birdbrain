import { ApiError, describeApiError, type AuthUser } from '../../api/client';
import type { View, ViewContext } from '../app';
import { SIGN_UP_PRIVACY_LINE, whatWeStoreFold } from '../components/what-we-store';
import { setSharingOn } from '../../species/sharing';
import { foldHint } from '../components/rows';
import { goBack } from '../router';
import { el } from '../dom';

/**
 * Sign in and Create account, each on its own page (DECISIONS.md #77). Both end with the
 * 6-digit code from the email; Create account then shows whether the account waits for
 * approval. The Account card in Settings links here and shows the signed-in state.
 */

/** Where both pages go back to. */
export const ACCOUNT_HREF = '#/settings/account';
/** Where a finished sign-in lands and "Your account" goes: My account (DECISIONS.md #79). */
export const MY_ACCOUNT_HREF = '#/account';

export const AUTH_TEXT = {
  signUpIntro: 'Optional. Adds Ask about this bird and sharing with friends. Sabih approves each account.',
  pendingTitle: 'Waiting for approval',
  pending: 'Account created. You’ll get an email when Sabih approves it.',
  pendingMeanwhile: 'Everything else works meanwhile.',
  readyTitle: 'Your account is ready',
  signUpCodeWrong: 'Wrong or expired code. Go back for a new one.',
  forgotIntro: 'We’ll email you a link to set a new password.',
  forgotSent: 'If that address has an account, a reset link is on its way (one use, 60 min). Check spam.',
  inviteExpired: 'This invite has expired or was used. You can still sign up and ask for a new one.',
  resetIntro: 'Type your new password twice.',
  resetDone: 'Password changed and you’re signed out everywhere. Sign in with the new one.',
  resetNoToken: 'Incomplete link. Open the email link again or ask for a new one.',
} as const;

/** The line above the Create account form when it was opened from an invite link (DECISIONS.md #80). */
export function inviteIntro(fromName: string): string {
  return `${fromName} invited you.`;
}

/** Folded under the share-back box (DECISIONS.md #100). */
export function inviteMore(fromName: string): string {
  return `Once Sabih approves you, you’ll be friends and see ${fromName}’s birds.`;
}

/** The consent box for sharing back; unticked until the person ticks it. The fold under it says what is shared. */
export function shareBackLabel(fromName: string): string {
  return `Share my birds with ${fromName}`;
}

/** "Enter the 6-digit code sent to x. It expires in 10 min." */
export function codeSentText(email: string, expiresInSeconds: number, purpose: 'sign-in' | 'sign-up'): string {
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return `Enter the 6-digit code sent to ${email}${purpose === 'sign-up' ? ' to finish' : ''}. It expires in ${minutes} min.`;
}

/**
 * Tokens taken out of the address bar during this page visit (DECISIONS.md #86). The pages remove
 * a reset or invite token from the URL as soon as they open; if the route is drawn a second time
 * (two quick address changes queue two `hashchange` events), that second drawing reads the
 * cleaned address and would wrongly say the link is incomplete. It uses the remembered token.
 */
const takenTokens: Partial<Record<'reset' | 'invite', string>> = {};

/** The token for this page: from the address (then remembered and removed), else the one remembered. */
export function takeToken(kind: 'reset' | 'invite', fromUrl: string | undefined, cleanHash: string): string | undefined {
  if (fromUrl) {
    takenTokens[kind] = fromUrl;
    if (typeof history !== 'undefined' && typeof location !== 'undefined') history.replaceState(null, '', `${location.pathname}${location.search}${cleanHash}`);
    return fromUrl;
  }
  return takenTokens[kind];
}

/** Forget a token once it is used up or refused, so the page no longer offers it. */
export function forgetToken(kind: 'reset' | 'invite'): void {
  delete takenTokens[kind];
}

/** Back link, title and the page body in one card. */
function page(title: string, testId: string, ...body: HTMLElement[]): { root: HTMLElement; card: HTMLElement } {
  const card = el('section', { class: 'card', 'data-testid': testId }, el('h2', null, title), ...body);
  // Back to where the person came from (the welcome layer, Settings…), not always Settings (UI/UX audit finding 8).
  const back = el('a', { class: 'btn small', href: ACCOUNT_HREF, 'data-testid': 'auth-back' }, '‹ Back');
  back.addEventListener('click', (e) => {
    e.preventDefault();
    goBack(ACCOUNT_HREF);
  });
  const root = el('div', null, el('div', { class: 'row' }, back), card);
  return { root, card };
}

let fieldCount = 0;
function field(label: string, input: HTMLInputElement): HTMLElement {
  const id = `auth-field-${++fieldCount}`;
  input.id = id;
  return el('div', { class: 'field' }, el('label', { for: id }, label), input);
}

function statusLine(testId = 'auth-message'): HTMLElement {
  return el('div', { class: 'notice info', role: 'status', 'data-testid': testId, hidden: true });
}

function show(line: HTMLElement, text: string): void {
  line.textContent = text;
  line.hidden = !text;
}

/**
 * The code step both pages share. `onDone` gets the signed-in user; a wrong code stays on
 * this step (up to the server's attempt limit), any other failure goes back.
 */
function codeStep(ctx: ViewContext, opts: { email: string; challenge: string; expiresInSeconds: number; purpose: 'sign-in' | 'sign-up'; onBack: (text: string) => void; onDone: (u: AuthUser) => void }): HTMLElement {
  const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: String.raw`\d{6}`, maxlength: '6', required: true, 'data-testid': 'code-input' });
  const verify = el('button', { class: 'btn primary', type: 'submit', 'data-testid': 'code-verify' }, 'Verify');
  const back = el('button', { class: 'btn', type: 'button', 'data-testid': 'code-back' }, opts.purpose === 'sign-up' ? 'Back' : 'Use a different email');
  const message = statusLine('code-message');
  const form = el('form', { class: 'stack', 'data-testid': 'code-step' }, el('p', { 'data-testid': 'code-sent' }, codeSentText(opts.email, opts.expiresInSeconds, opts.purpose)), field('6-digit code', code), el('div', { class: 'row' }, verify, back), message);
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = verify.disabled = true;
    try {
      opts.onDone(await ctx.api.verify(opts.challenge, code.value.trim()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) show(message, opts.purpose === 'sign-up' ? AUTH_TEXT.signUpCodeWrong : describeApiError(err));
      else opts.onBack(describeApiError(err));
    } finally {
      busy = verify.disabled = false;
    }
  });
  back.addEventListener('click', () => opts.onBack(''));
  queueMicrotask(() => code.focus());
  return form;
}

/** Shown on both pages when someone is already signed in. */
function alreadySignedIn(u: AuthUser): HTMLElement {
  return el('div', { class: 'stack', 'data-testid': 'auth-signed-in' }, el('p', null, `You are signed in as ${u.email}.`), el('a', { class: 'btn primary', href: MY_ACCOUNT_HREF }, 'Go to your account'));
}

export function signInView(ctx: ViewContext): View {
  const { api } = ctx;
  const message = statusLine();
  const body = el('div', { class: 'stack' });
  const { root } = page('Sign in', 'signin-page', body, message);

  const form = () => {
    const email = el('input', { type: 'email', autocomplete: 'email', required: true, 'data-testid': 'signin-email' });
    const password = el('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: '128', 'data-testid': 'signin-password' });
    const submit = el('button', { class: 'btn primary block', type: 'submit', 'data-testid': 'signin-submit' }, 'Sign in');
    const f = el(
      'form',
      { class: 'stack' },
      field('Email', email),
      field('Password', password),
      submit,
      el('p', null, el('a', { href: '#/forgot-password', 'data-testid': 'to-forgot' }, 'Forgot password?')),
      el('p', { class: 'small muted' }, 'We email you a 6-digit code each time you sign in.'),
      el('p', null, 'New here? ', el('a', { href: '#/signup', 'data-testid': 'to-signup' }, 'Create an account')),
    );
    let busy = false;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || !f.reportValidity()) return;
      busy = submit.disabled = true;
      show(message, '');
      try {
        const res = await api.login(email.value.trim(), password.value);
        body.replaceChildren(
          codeStep(ctx, {
            email: email.value.trim(),
            challenge: res.challenge,
            expiresInSeconds: res.expiresInSeconds,
            purpose: 'sign-in',
            onBack: render,
            onDone: () => {
              location.hash = MY_ACCOUNT_HREF;
            },
          }),
        );
      } catch (err) {
        show(message, describeApiError(err));
      } finally {
        busy = submit.disabled = false;
      }
    });
    return f;
  };

  const render = (text: string) => {
    show(message, text);
    body.replaceChildren(api.user ? alreadySignedIn(api.user) : form());
  };
  render('');
  return { el: root };
}

export function signUpView(ctx: ViewContext, inviteFromUrl?: string): View {
  const { api } = ctx;
  // Like the reset link, the invite token leaves the address bar at once and stays in memory only.
  const invite = takeToken('invite', inviteFromUrl, '#/signup');
  const message = statusLine();
  const body = el('div', { class: 'stack' });
  const { root } = page('Create account', 'signup-page', body, message);
  /** The inviter's name once the link checks out; null without a link or when it is no longer valid. */
  let inviter: string | null = null;
  let inviteChecked = !invite;
  const shareBack = el('input', { type: 'checkbox', 'data-testid': 'signup-share-back' });
  let inviteHost: HTMLElement | null = null;
  /** Who invited them and the unticked consent box, or a note that the link no longer works. */
  const fillInvite = () => {
    if (!inviteHost) return;
    if (inviter) inviteHost.replaceChildren(el('div', { class: 'stack invite-box', 'data-testid': 'signup-invite' }, el('p', null, inviteIntro(inviter)), el('div', { class: 'switch-folded' }, el('label', { class: 'switch' }, el('span', null, shareBackLabel(inviter)), shareBack), foldHint('Birds and the last day seen', [el('p', null, inviteMore(inviter))], { testId: 'signup-invite-more' }))));
    else if (invite && inviteChecked) inviteHost.replaceChildren(el('p', { class: 'notice info', 'data-testid': 'signup-invite-expired' }, AUTH_TEXT.inviteExpired));
    else inviteHost.replaceChildren();
  };

  const done = (u: AuthUser, shareBack: boolean) => {
    forgetToken('invite');
    // The ticked box is this person's "Share my species list" consent; it uploads once they are approved.
    if (shareBack) setSharingOn(u.id, true);
    show(message, '');
    const pending = u.status === 'pending';
    body.replaceChildren(
      el(
        'div',
        { class: 'stack', 'data-testid': pending ? 'signup-pending' : 'signup-ready', role: 'status' },
        el('h3', null, pending ? AUTH_TEXT.pendingTitle : AUTH_TEXT.readyTitle),
        pending ? el('p', null, AUTH_TEXT.pending) : el('p', null, `You are signed in as ${u.email}.`),
        pending ? el('p', { class: 'small muted' }, AUTH_TEXT.pendingMeanwhile) : null,
        el('div', { class: 'row' }, el('a', { class: 'btn primary', href: '#/listen' }, 'Start listening'), el('a', { class: 'btn', href: MY_ACCOUNT_HREF }, 'Your account')),
      ),
    );
  };

  const form = () => {
    const name = el('input', { type: 'text', autocomplete: 'nickname', maxlength: '40', 'data-testid': 'signup-name' });
    const email = el('input', { type: 'email', autocomplete: 'email', required: true, 'data-testid': 'signup-email' });
    const password = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', 'data-testid': 'signup-password' });
    const again = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', 'data-testid': 'signup-password-again' });
    const submit = el('button', { class: 'btn primary block', type: 'submit', 'data-testid': 'signup-submit' }, 'Create account');
    const match = () => again.setCustomValidity(again.value && again.value !== password.value ? 'The two passwords are different.' : '');
    password.addEventListener('input', match);
    again.addEventListener('input', match);
    inviteHost = el('div', { class: 'stack' });
    fillInvite();
    const f = el(
      'form',
      { class: 'stack' },
      inviteHost,
      el('p', { class: 'small' }, AUTH_TEXT.signUpIntro),
      field('Your name (what friends see; optional)', name),
      field('Email', email),
      field('Password (8 or more characters)', password),
      field('Password again', again),
      submit,
      el('p', { class: 'small muted', 'data-testid': 'signup-privacy' }, SIGN_UP_PRIVACY_LINE),
      whatWeStoreFold('what-we-store-signup'),
      el('p', null, 'Already have an account? ', el('a', { href: '#/signin', 'data-testid': 'to-signin' }, 'Sign in')),
    );
    let busy = false;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      match();
      if (busy || !f.reportValidity()) return;
      busy = submit.disabled = true;
      show(message, '');
      try {
        const address = email.value.trim();
        const sharing = inviter !== null && shareBack.checked;
        const res = await api.signup(address, password.value, { name: name.value.trim() || undefined, invite: inviter !== null ? invite : undefined, shareWithInviter: sharing });
        body.replaceChildren(codeStep(ctx, { email: address, challenge: res.challenge, expiresInSeconds: res.expiresInSeconds, purpose: 'sign-up', onBack: render, onDone: (u) => done(u, sharing) }));
      } catch (err) {
        show(message, describeApiError(err));
      } finally {
        busy = submit.disabled = false;
      }
    });
    return f;
  };

  const render = (text: string) => {
    show(message, text);
    body.replaceChildren(api.user ? alreadySignedIn(api.user) : form());
  };
  render('');
  if (invite) {
    void api
      .inviteInfo(invite)
      .then((info) => {
        inviter = info.fromName;
      })
      .catch(() => {
        inviter = null;
        forgetToken('invite');
      })
      .finally(() => {
        inviteChecked = true;
        fillInvite();
      });
  }
  return { el: root };
}

export function forgotPasswordView(ctx: ViewContext): View {
  const message = statusLine();
  const body = el('div', { class: 'stack' });
  const { root } = page('Reset your password', 'forgot-page', body, message);
  const email = el('input', { type: 'email', autocomplete: 'email', required: true, 'data-testid': 'forgot-email' });
  const submit = el('button', { class: 'btn primary block', type: 'submit', 'data-testid': 'forgot-submit' }, 'Email me a reset link');
  const f = el('form', { class: 'stack' }, el('p', null, AUTH_TEXT.forgotIntro), field('Email', email), submit, el('p', null, el('a', { href: '#/signin' }, '‹ Back to sign in')));
  let busy = false;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !f.reportValidity()) return;
    busy = submit.disabled = true;
    show(message, '');
    try {
      await ctx.api.forgotPassword(email.value.trim());
      body.replaceChildren(el('div', { class: 'stack', role: 'status', 'data-testid': 'forgot-sent' }, el('p', null, AUTH_TEXT.forgotSent), el('a', { class: 'btn', href: '#/signin' }, 'Back to sign in')));
    } catch (err) {
      show(message, describeApiError(err));
    } finally {
      busy = submit.disabled = false;
    }
  });
  body.append(f);
  return { el: root };
}

/**
 * The page the emailed link opens. The token is taken out of the address bar at once, so it is
 * not left in the browser history; it stays in memory for this page only.
 */
export function resetPasswordView(ctx: ViewContext, tokenFromUrl: string): View {
  const token = takeToken('reset', tokenFromUrl || undefined, '#/reset-password') ?? '';
  const message = statusLine();
  const body = el('div', { class: 'stack' });
  const { root } = page('Choose a new password', 'reset-page', body, message);
  if (!token) {
    body.append(el('p', { 'data-testid': 'reset-no-token' }, AUTH_TEXT.resetNoToken), el('a', { class: 'btn', href: '#/forgot-password' }, 'Ask for a new link'));
    return { el: root };
  }
  const password = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', 'data-testid': 'reset-password' });
  const again = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', 'data-testid': 'reset-password-again' });
  const submit = el('button', { class: 'btn primary block', type: 'submit', 'data-testid': 'reset-submit' }, 'Save new password');
  const match = () => again.setCustomValidity(again.value && again.value !== password.value ? 'The two passwords are different.' : '');
  password.addEventListener('input', match);
  again.addEventListener('input', match);
  const f = el('form', { class: 'stack' }, el('p', null, AUTH_TEXT.resetIntro), field('New password (8 or more characters)', password), field('New password again', again), submit);
  let busy = false;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    match();
    if (busy || !f.reportValidity()) return;
    busy = submit.disabled = true;
    show(message, '');
    try {
      await ctx.api.resetPassword(token, password.value);
      forgetToken('reset');
      body.replaceChildren(el('div', { class: 'stack', role: 'status', 'data-testid': 'reset-done' }, el('p', null, AUTH_TEXT.resetDone), el('a', { class: 'btn primary', href: '#/signin' }, 'Sign in')));
    } catch (err) {
      show(message, describeApiError(err));
      if (err instanceof ApiError && err.code === 'invalid_token') forgetToken('reset');
      if (err instanceof ApiError && err.code === 'invalid_token') body.replaceChildren(el('a', { class: 'btn', href: '#/forgot-password' }, 'Ask for a new link'));
    } finally {
      busy = submit.disabled = false;
    }
  });
  body.append(f);
  return { el: root };
}
