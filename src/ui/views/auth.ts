import { ApiError, describeApiError, type AuthUser } from '../../api/client';
import type { View, ViewContext } from '../app';
import { SIGN_UP_PRIVACY_LINE, whatWeStoreFold } from '../components/what-we-store';
import { el } from '../dom';

/**
 * Sign in and Create account, each on its own page (DECISIONS.md #77). Both end with the
 * 6-digit code from the email; Create account then shows whether the account waits for
 * approval. The Account card in Settings links here and shows the signed-in state.
 */

/** Where both pages go back to, and where a finished sign-in lands. */
export const ACCOUNT_HREF = '#/settings/account';

export const AUTH_TEXT = {
  signUpIntro: 'An account is optional. It adds Ask about this bird and sharing your species list with friends. Sabih approves each new account by hand.',
  pendingTitle: 'Waiting for approval',
  pending: 'Your account is created. Sabih approves each new account by hand, and you will get an email when yours is approved. We also emailed you this note.',
  pendingMeanwhile: 'Until then, listening and identifying birds work as before.',
  readyTitle: 'Your account is ready',
  signUpCodeWrong: 'That code is wrong or has expired. Go back and create the account again to get a new code.',
} as const;

/** "We emailed a 6-digit code to x. It expires in 10 minutes." */
export function codeSentText(email: string, expiresInSeconds: number, purpose: 'sign-in' | 'sign-up'): string {
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  const why = purpose === 'sign-up' ? ' Enter it to finish creating your account.' : '';
  return `We emailed a 6-digit code to ${email}.${why} It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** Back link, title and the page body in one card. */
function page(title: string, testId: string, ...body: HTMLElement[]): { root: HTMLElement; card: HTMLElement } {
  const card = el('section', { class: 'card', 'data-testid': testId }, el('h2', null, title), ...body);
  const root = el('div', null, el('div', { class: 'row' }, el('a', { class: 'btn small', href: ACCOUNT_HREF, 'data-testid': 'auth-back' }, '‹ Settings')), card);
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
  const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: '6', required: true, 'data-testid': 'code-input' });
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
  return el('div', { class: 'stack', 'data-testid': 'auth-signed-in' }, el('p', null, `You are signed in as ${u.email}.`), el('a', { class: 'btn primary', href: ACCOUNT_HREF }, 'Go to your account'));
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
              location.hash = ACCOUNT_HREF;
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

export function signUpView(ctx: ViewContext): View {
  const { api } = ctx;
  const message = statusLine();
  const body = el('div', { class: 'stack' });
  const { root } = page('Create account', 'signup-page', body, message);

  const done = (u: AuthUser) => {
    show(message, '');
    const pending = u.status === 'pending';
    body.replaceChildren(
      el(
        'div',
        { class: 'stack', 'data-testid': pending ? 'signup-pending' : 'signup-ready', role: 'status' },
        el('h3', null, pending ? AUTH_TEXT.pendingTitle : AUTH_TEXT.readyTitle),
        pending ? el('p', null, AUTH_TEXT.pending) : el('p', null, `You are signed in as ${u.email}.`),
        pending ? el('p', { class: 'small muted' }, AUTH_TEXT.pendingMeanwhile) : null,
        el('div', { class: 'row' }, el('a', { class: 'btn primary', href: '#/listen' }, 'Start listening'), el('a', { class: 'btn', href: ACCOUNT_HREF }, 'Your account')),
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
    const f = el(
      'form',
      { class: 'stack' },
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
        const res = await api.signup(address, password.value, name.value.trim() || undefined);
        body.replaceChildren(codeStep(ctx, { email: address, challenge: res.challenge, expiresInSeconds: res.expiresInSeconds, purpose: 'sign-up', onBack: render, onDone: done }));
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
