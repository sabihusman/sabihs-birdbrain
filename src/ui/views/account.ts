import { ApiError, describeApiError, type AuthUser } from '../../api/client';
import { isMember } from '../../app/access';
import { setSharingOn } from '../../species/sharing';
import type { ViewContext } from '../app';
import { friendsPanel } from '../components/friends-panel';
import { el } from '../dom';

type Step = 'signed-out' | 'code' | 'signed-in';

/** Account card: sign up, sign in with emailed code, display name, status, friends and sharing (members), sign out, delete account. */
export function accountSection(ctx: ViewContext): { el: HTMLElement; dispose: () => void } {
  const { api } = ctx;
  const root = el('section', { class: 'card', 'data-testid': 'account' });
  let panel: { el: HTMLElement; dispose: () => void } | null = null;
  let step: Step = api.signedIn ? 'signed-in' : 'signed-out';
  let challenge = '';
  let message = '';
  let busy = false;

  const render = () => {
    panel?.dispose();
    panel = null;
    root.replaceChildren();
    root.appendChild(el('h2', null, 'Account'));
    const user = api.user;
    if (step === 'signed-in' && user) {
      root.append(renderSignedIn(user));
    } else if (step === 'code') {
      root.append(renderCode());
    } else {
      root.append(renderSignedOut());
    }
    if (message) root.append(el('div', { class: 'notice info', role: 'status' }, message));
  };

  const statusText = (u: AuthUser) => {
    switch (u.status) {
      case 'approved':
        return u.role === 'admin' ? 'Admin. Member features are enabled.' : 'Member. You can ask AI questions about any bird on its species page.';
      case 'pending':
        return 'Awaiting approval by Sabih. Everything on-device keeps working; member features unlock once approved.';
      case 'rejected':
        return 'This account was not approved.';
      case 'disabled':
        return 'This account is disabled.';
    }
  };

  const renderSignedIn = (u: AuthUser) => {
    const out = el('button', { class: 'btn', type: 'button' }, 'Sign out');
    out.addEventListener('click', async () => {
      await api.logout();
      step = 'signed-out';
      message = 'Signed out.';
      render();
    });
    const identity = el('div', { class: 'stack', 'data-testid': 'account-identity' }, el('div', null, el('strong', { 'data-testid': 'account-name' }, u.name || u.email), el('div', { class: 'small muted', 'data-testid': 'account-email' }, u.email)));
    const editName = el('button', { class: 'btn small', type: 'button', 'data-testid': 'edit-name' }, 'Edit name');
    editName.addEventListener('click', () => {
      const input = el('input', { type: 'text', value: u.name, maxlength: '40', required: true, autocomplete: 'nickname', 'aria-label': 'Display name', 'data-testid': 'name-input' });
      const save = el('button', { class: 'btn small primary', type: 'submit' }, 'Save');
      const cancel = el('button', { class: 'btn small', type: 'button' }, 'Cancel');
      const form = el('form', { class: 'stack' }, el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'Display name (what friends see; 1–40 characters)'), input), el('div', { class: 'row' }, save, cancel));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!form.reportValidity() || busy) return;
        busy = true;
        save.disabled = true;
        try {
          await api.setName(input.value.trim());
          message = 'Name saved.';
        } catch (err) {
          message = describeApiError(err);
        } finally {
          busy = false;
          render();
        }
      });
      cancel.addEventListener('click', () => render());
      identity.replaceChildren(form);
      input.focus();
    });
    identity.append(el('div', { class: 'row' }, editName));

    // Delete account: an inline two-step confirmation instead of a pop-up.
    const delBtn = el('button', { class: 'btn small danger', type: 'button', 'data-testid': 'delete-account' }, 'Delete account');
    const delBox = el('div', { class: 'stack' }, delBtn);
    delBtn.addEventListener('click', () => {
      const yes = el('button', { class: 'btn danger', type: 'button', 'data-testid': 'delete-account-confirm' }, 'Yes, delete my account');
      const no = el('button', { class: 'btn', type: 'button' }, 'Keep my account');
      delBox.replaceChildren(el('div', { class: 'notice warn', role: 'alert' }, 'This deletes your account on the server: your sign-in, your friends and invites, and your shared species list, right away. Recordings and detections on this device stay until you delete them in Data below. This cannot be undone.'), el('div', { class: 'row' }, yes, no));
      no.addEventListener('click', () => delBox.replaceChildren(delBtn));
      yes.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        yes.disabled = no.disabled = true;
        try {
          setSharingOn(u.id, false); // the server copy goes with the account; the device flag must not linger
          await api.deleteAccount();
          step = 'signed-out';
          message = 'Your account was deleted.';
        } catch (err) {
          message = describeApiError(err);
        } finally {
          busy = false;
          render();
        }
      });
    });

    const children: Array<HTMLElement | null> = [identity, el('div', { class: 'small', 'data-testid': 'account-status' }, statusText(u)), u.role === 'admin' ? el('a', { class: 'btn small', href: '#/admin' }, 'Open admin page') : null];
    if (isMember(u)) {
      panel = friendsPanel(ctx);
      children.push(el('hr', { class: 'rule' }), panel.el);
    }
    children.push(el('hr', { class: 'rule' }), el('div', { class: 'row' }, out), delBox);
    return el('div', { class: 'stack' }, ...children);
  };

  const renderSignedOut = () => {
    const email = el('input', { type: 'email', autocomplete: 'email', placeholder: 'Email', required: true, 'aria-label': 'Email' });
    const password = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password (10+ characters)', minlength: '10', required: true, 'aria-label': 'Password' });
    const signIn = el('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const signUp = el('button', { class: 'btn', type: 'button' }, 'Create account');
    const form = el('form', { class: 'stack' }, el('div', { class: 'field' }, email), el('div', { class: 'field' }, password), el('div', { class: 'row' }, signIn, signUp), el('p', { class: 'small muted' }, 'Signing in sends a 6-digit code to your email every time. New accounts wait for approval before member features work. Your audio and recordings never leave this device either way.'));
    const run = async (fn: () => Promise<void>) => {
      if (busy) return;
      busy = true;
      signIn.disabled = signUp.disabled = true;
      try {
        await fn();
      } catch (e) {
        message = describeApiError(e);
      } finally {
        busy = false;
        render();
      }
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      void run(async () => {
        const res = await api.login(email.value, password.value);
        challenge = res.challenge;
        step = 'code';
        message = `We emailed a code to ${email.value}. It expires in ${Math.round(res.expiresInSeconds / 60)} minutes.`;
      });
    });
    signUp.addEventListener('click', () => {
      if (!form.reportValidity()) return;
      void run(async () => {
        const res = await api.signup(email.value, password.value);
        message = res.message;
      });
    });
    return form;
  };

  const renderCode = () => {
    const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: '6', placeholder: '6-digit code', required: true, 'aria-label': 'Sign-in code' });
    const verify = el('button', { class: 'btn primary', type: 'submit' }, 'Verify');
    const back = el('button', { class: 'btn', type: 'button' }, 'Back');
    const form = el('form', { class: 'stack' }, el('div', { class: 'field' }, code), el('div', { class: 'row' }, verify, back));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity() || busy) return;
      busy = true;
      verify.disabled = true;
      try {
        await api.verify(challenge, code.value.trim());
        step = 'signed-in';
        message = '';
      } catch (err) {
        message = describeApiError(err);
        if (err instanceof ApiError && err.status !== 401) step = 'signed-out';
      } finally {
        busy = false;
        render();
      }
    });
    back.addEventListener('click', () => {
      step = 'signed-out';
      message = '';
      render();
    });
    return form;
  };

  const unsub = api.on('change', (u) => {
    if (!u && step === 'signed-in') {
      step = 'signed-out';
      message = 'Your session ended. Sign in again.';
      render();
    }
  });
  render();
  return {
    el: root,
    dispose() {
      unsub();
      panel?.dispose();
    },
  };
}
