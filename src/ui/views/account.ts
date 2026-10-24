import { DEFAULT_SETTINGS } from '../../app/settings';
import { ApiError, describeApiError, type AuthUser } from '../../api/client';
import { canManageUsers, isMember } from '../../app/access';
import { setSharingOn } from '../../species/sharing';
import { clearAllData } from '../../storage/db';
import type { ViewContext } from '../app';
import { disclosure } from '../components/disclosure';
import { friendsPanel, sharingRow } from '../components/friends-panel';
import { actionRow, linkRow, rowGroup } from '../components/rows';
import { SIGN_UP_PRIVACY_LINE, whatWeStoreFold } from '../components/what-we-store';
import { el } from '../dom';

type Step = 'signed-out' | 'signed-in' | 'delete' | 'deleted';

/** "Not available for the admin account": the admin approves everyone else, so it cannot delete itself. */
export const ADMIN_DELETE_ROW_NOTE = 'Not available for the admin account';

/** First letter of the display name (or the email), for the avatar. */
export function avatarLetter(user: { name?: string | null; email: string }): string {
  const source = (user.name ?? '').trim() || user.email;
  return (source[0] ?? '?').toUpperCase();
}

/**
 * Account card: links to the Sign in and Create account pages (DECISIONS.md #77), then grouped rows for the
 * features we already have (display name, admin page, friends and sharing, sign out,
 * delete). Long text sits behind collapsed rows so the card fits a phone; deleting
 * opens its own screen rather than unfolding inline (DESIGN_GUIDE.md §5).
 */
export function accountSection(ctx: ViewContext): { el: HTMLElement; dispose: () => void } {
  const { api, controller } = ctx;
  const root = el('section', { class: 'card', 'data-testid': 'account' });
  const panels: Array<{ dispose: () => void }> = [];
  let step: Step = api.signedIn ? 'signed-in' : 'signed-out';
  let message = '';
  let busy = false;
  /** True while the delete request runs, so the session-ended handler leaves the confirmation alone. */
  let deleting = false;

  const disposePanels = () => {
    for (const p of panels.splice(0)) p.dispose();
  };

  const render = () => {
    disposePanels();
    root.replaceChildren();
    const user = api.user;
    if (step === 'delete' && user) {
      root.append(renderDeleteScreen(user));
    } else {
      root.appendChild(el('h2', null, 'Account'));
      if (step === 'deleted') root.append(renderDeleted());
      else if (step === 'signed-in' && user) root.append(renderSignedIn(user));
      else root.append(renderSignedOut());
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

  /** Avatar, name, email and the Admin/Member pill. */
  const identityCard = (u: AuthUser) =>
    el(
      'div',
      { class: 'account-head', 'data-testid': 'account-identity' },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, avatarLetter(u)),
      el('div', { class: 'account-who' }, el('strong', { 'data-testid': 'account-name' }, u.name || u.email), el('div', { class: 'small muted', 'data-testid': 'account-email' }, u.email)),
      el('span', { class: `pill ${u.role === 'admin' ? 'pill-admin' : 'pill-member'}`, 'data-testid': 'account-role' }, u.role === 'admin' ? 'Admin' : 'Member'),
    );

  /** The display-name form, opened from its row and closed again on save or cancel. */
  const nameForm = (u: AuthUser, host: HTMLElement) => {
    const input = el('input', { type: 'text', value: u.name, maxlength: '40', required: true, autocomplete: 'nickname', 'aria-label': 'Display name', 'data-testid': 'name-input' });
    const save = el('button', { class: 'btn small primary', type: 'submit' }, 'Save');
    const cancel = el('button', { class: 'btn small', type: 'button' }, 'Cancel');
    const form = el('form', { class: 'stack name-form' }, el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'Display name (what friends see; 1–40 characters)'), input), el('div', { class: 'row' }, save, cancel));
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
    host.replaceChildren(form);
    input.focus();
  };

  /** Change my password: the current one, then the new one twice. Other devices are signed out. */
  const passwordForm = (host: HTMLElement) => {
    const current = el('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: '128', 'aria-label': 'Current password', 'data-testid': 'current-password' });
    const next = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', 'aria-label': 'New password (8+ characters)', 'data-testid': 'new-password' });
    const again = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', 'aria-label': 'New password again', 'data-testid': 'new-password-again' });
    const save = el('button', { class: 'btn small primary', type: 'submit' }, 'Change password');
    const cancel = el('button', { class: 'btn small', type: 'button' }, 'Cancel');
    const form = el(
      'form',
      { class: 'stack name-form', 'data-testid': 'password-form' },
      el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'Current password'), current),
      el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'New password (8+ characters)'), next),
      el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'New password again'), again),
      el('div', { class: 'row' }, save, cancel),
      el('p', { class: 'small' }, 'Forgot your current password? ', el('a', { href: '#/forgot-password', 'data-testid': 'to-forgot-from-change' }, 'Reset it by email')),
    );
    const match = () => again.setCustomValidity(again.value && again.value !== next.value ? 'The two new passwords are different.' : '');
    next.addEventListener('input', match);
    again.addEventListener('input', match);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      match();
      if (!form.reportValidity() || busy) return;
      busy = true;
      save.disabled = true;
      try {
        await api.changePassword(current.value, next.value);
        message = 'Password changed. Other devices were signed out.';
      } catch (err) {
        message = describeApiError(err);
      } finally {
        busy = false;
        render();
      }
    });
    cancel.addEventListener('click', () => render());
    host.replaceChildren(form);
    current.focus();
  };

  const renderSignedIn = (u: AuthUser) => {
    const nameHost = el('div', { class: 'stack name-host' });
    const accountRows = [
      actionRow('Display name', { hint: u.name || u.email, testId: 'edit-name', onClick: () => nameForm(u, nameHost) }),
      actionRow('Change password', { hint: '8 to 128 characters', testId: 'change-password', onClick: () => passwordForm(nameHost) }),
      // Admin only (DECISIONS.md #61): one entry to the user management page; Ask costs is linked from there.
      canManageUsers(u) ? linkRow('Manage users', '#/admin/users', { hint: 'Approve, reset passwords, delete accounts', testId: 'manage-users' }) : null,
    ];

    const groups: Array<HTMLElement | null> = [identityCard(u), el('div', { class: 'small', 'data-testid': 'account-status' }, statusText(u)), rowGroup(null, ...accountRows), nameHost];

    if (isMember(u)) {
      const share = sharingRow(ctx);
      const panel = friendsPanel(ctx);
      panels.push(share, panel);
      const friends = disclosure({ title: 'Friends and invites', summary: 'Invite, accept, remove', testId: 'friends-fold', className: 'fold-row' }, panel.el);
      groups.push(rowGroup('Friends', share.el, friends));
    }

    const out = el('button', { class: 'btn block', type: 'button', 'data-testid': 'sign-out' }, 'Sign out');
    out.addEventListener('click', async () => {
      await api.logout();
      step = 'signed-out';
      message = 'Signed out.';
      render();
    });
    groups.push(el('div', { class: 'stack' }, out));

    const isAdmin = u.role === 'admin';
    groups.push(
      rowGroup(
        null,
        actionRow('Delete my account', {
          hint: isAdmin ? undefined : 'Removes everything the server holds',
          testId: 'delete-row',
          danger: true,
          disabled: isAdmin,
          disabledNote: ADMIN_DELETE_ROW_NOTE,
          onClick: () => {
            step = 'delete';
            message = '';
            render();
          },
        }),
      ),
    );

    return el('div', { class: 'stack' }, ...groups);
  };

  /** Its own screen: the password and the word DELETE, with a way back. */
  const renderDeleteScreen = (u: AuthUser) => {
    const back = el('button', { class: 'btn small', type: 'button', 'data-testid': 'delete-cancel' }, '‹ Back');
    back.addEventListener('click', () => {
      step = 'signed-in';
      message = '';
      render();
    });
    const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Your password', required: true, 'aria-label': 'Your password', 'data-testid': 'delete-password' });
    const word = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, placeholder: 'DELETE', required: true, 'aria-label': 'Type DELETE to confirm', 'data-testid': 'delete-word' });
    const go = el('button', { class: 'btn danger block', type: 'submit', disabled: true, 'data-testid': 'delete-account' }, 'Delete my account permanently');
    const update = () => {
      go.disabled = busy || !pw.value || !word.value.trim();
    };
    pw.addEventListener('input', update);
    word.addEventListener('input', update);
    const form = el(
      'form',
      { class: 'stack' },
      el('p', { class: 'small', 'data-testid': 'delete-warning' }, 'This deletes your account right away and for good: your sign-in, sessions, friends, invites and your shared species list. There is no undo and no waiting period. Listening and identifying keep working without an account.'),
      el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'Your password'), pw),
      el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'Type DELETE to confirm'), word),
      el('div', { class: 'stack' }, go),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || !form.reportValidity()) return;
      if (word.value.trim() !== 'DELETE') {
        message = describeApiError(new ApiError(400, 'confirm_mismatch'));
        render();
        return;
      }
      busy = deleting = true;
      update();
      try {
        await api.deleteAccount(pw.value, word.value.trim());
        setSharingOn(u.id, false); // the server copy went with the account; the device flag must not linger
        step = 'deleted';
        message = '';
      } catch (err) {
        message = describeApiError(err);
        step = api.signedIn ? 'delete' : 'signed-out';
      } finally {
        busy = deleting = false;
        render();
      }
    });
    return el('div', { class: 'stack', 'data-testid': 'delete-screen' }, el('div', { class: 'row' }, back), el('h2', null, 'Delete my account'), form);
  };

  /** After a deletion: signed out, with the choice to wipe this phone's sightings too (off by default). */
  const renderDeleted = () => {
    const wipe = el('input', { type: 'checkbox', 'data-testid': 'wipe-phone' });
    const done = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'deleted-done' }, 'Done');
    const box = el(
      'div',
      { class: 'stack', 'data-testid': 'account-deleted', role: 'status' },
      el('p', null, el('strong', null, 'Your account was deleted.'), ' Everything the server held for you is gone and you are signed out. A short confirmation was emailed to you.'),
      el('p', { class: 'small muted' }, 'Sightings, recordings and clips saved on this phone are still here. Listening and identifying keep working without an account.'),
      el('label', { class: 'row', style: 'gap:8px;align-items:center' }, wipe, 'Also clear sightings saved on this phone'),
      el('div', { class: 'row' }, done),
    );
    done.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      done.disabled = true;
      try {
        if (wipe.checked) {
          await clearAllData();
          controller.settings.update({ listenLayout: DEFAULT_SETTINGS.listenLayout }); // fresh start: default layout (DECISIONS.md #63)
          controller.emit('detections-changed', undefined);
          message = 'Sightings on this phone were cleared.';
        } else {
          message = '';
        }
        step = 'signed-out';
      } finally {
        busy = false;
        render();
      }
    });
    return box;
  };

  /** Signed out: two buttons to the Sign in and Create account pages (DECISIONS.md #77). */
  const renderSignedOut = () =>
    el(
      'div',
      { class: 'stack' },
      el('p', { class: 'small' }, 'An account is optional. It adds Ask about this bird and sharing your species list with friends. Sabih approves each new account by hand.'),
      el('div', { class: 'row' }, el('a', { class: 'btn primary', href: '#/signin', 'data-testid': 'account-signin' }, 'Sign in'), el('a', { class: 'btn', href: '#/signup', 'data-testid': 'account-signup' }, 'Create account')),
      el('p', { class: 'small muted', 'data-testid': 'signup-privacy' }, SIGN_UP_PRIVACY_LINE),
      whatWeStoreFold('what-we-store-signup'),
    );

  const unsub = api.on('change', (u) => {
    if (!u && (step === 'signed-in' || step === 'delete') && !deleting) {
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
      disposePanels();
    },
  };
}
