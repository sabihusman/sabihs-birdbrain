import { describeApiError, type Friend, type FriendInvite } from '../../api/client';
import { SHARING_CONSENT_TEXT } from '../../species/sharing';
import type { ViewContext } from '../app';
import { el, fmtDate } from '../dom';
import { switchRow, textRow } from './rows';

/**
 * Friends and sharing, on the My account page for approved members (DECISIONS.md #79)
 * (DECISIONS.md #44): invites for me (accept / decline), my friends
 * (remove), add a friend by email, and the "Share my species list with
 * friends" switch with its consent text. Everything goes through the API
 * client; the list is fetched when the panel opens and after each action.
 */
/** One line under the sharing switch. */
export function shareStatusText(enabled: boolean, lastError: string | null): string {
  if (!enabled) return 'Sharing is off. Nothing is on the server.';
  if (lastError) return `Sharing is on, but the last upload failed (${lastError}). Retrying soon.`;
  return 'Sharing is on. Updated after each sighting.';
}

/**
 * Under the invite form (DECISIONS.md #80): sending an invite is the sender's yes to sharing with that
 * person, but only while "Share my species list" is on; it never turns that switch on by itself,
 * because that would also share with every other friend.
 */
export function inviteShareNote(sharingOn: boolean): string {
  return sharingOn
    ? 'Once you’re friends they see your list; their switch stops it.'
    : 'Your list isn’t shared. Turn on sharing above for friends to see it.';
}

/** What a per-friend switch did, in plain words (DECISIONS.md #79). */
export function friendShareNotice(name: string, on: boolean): string {
  return on ? `${name} can see your species list again.` : `${name} no longer sees your list (you still see theirs).`;
}

export function friendsPanel(ctx: ViewContext): { el: HTMLElement; dispose: () => void; sharingChanged: () => void } {
  const { api, friends: cache, notify } = ctx;
  const root = el('div', { class: 'stack friends-panel', 'data-testid': 'friends' });
  const invitesBox = el('div', { class: 'stack', 'data-testid': 'friend-invites' });
  const friendsBox = el('div', { class: 'stack', 'data-testid': 'friend-list' });
  const status = el('div', { class: 'small muted', role: 'status' }, '');
  let busy = false;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      notify({ kind: 'error', text: describeApiError(e) });
    } finally {
      busy = false;
    }
  };

  const renderInvites = (invites: FriendInvite[]) => {
    invitesBox.replaceChildren();
    if (invites.length === 0) return;
    invitesBox.append(el('h3', null, 'Invites for you'));
    for (const inv of invites) {
      const accept = el('button', { class: 'btn small primary', type: 'button' }, 'Accept');
      const decline = el('button', { class: 'btn small', type: 'button' }, 'Decline');
      const row = el('div', { class: 'friend-row', 'data-testid': 'friend-invite' }, el('div', { class: 'friend-name' }, el('strong', null, inv.fromName), el('div', { class: 'small muted' }, `invited you · expires ${fmtDate(inv.expiresAt)}`)), el('div', { class: 'row' }, accept, decline));
      const respond = (action: 'accept' | 'decline') =>
        run(async () => {
          accept.disabled = decline.disabled = true;
          await api.respondToInvite(inv.id, action);
          notify({ kind: 'info', text: action === 'accept' ? `You and ${inv.fromName} are now friends.` : 'Invite declined.' });
          await load();
          if (action === 'accept') void cache.refresh();
        });
      accept.addEventListener('click', () => void respond('accept'));
      decline.addEventListener('click', () => void respond('decline'));
      invitesBox.append(row);
    }
  };

  const renderFriends = (list: Friend[]) => {
    friendsBox.replaceChildren(el('h3', null, 'Friends'));
    if (list.length === 0) {
      friendsBox.append(el('p', { class: 'small muted' }, 'No friends yet. Invite someone by email below.'));
      return;
    }
    for (const f of list) {
      const shareOn = f.sharing !== false;
      const share = el('input', { type: 'checkbox', checked: shareOn, 'aria-label': `Share my species list with ${f.name}`, 'data-testid': 'friend-share' });
      const remove = el('button', { class: 'btn small', type: 'button', 'aria-label': `Remove ${f.name} from your friends`, 'data-testid': 'friend-remove' }, 'Remove');
      share.addEventListener('change', () => {
        const on = share.checked;
        share.disabled = true;
        void run(async () => {
          try {
            await api.setFriendSharing(f.id, on);
            notify({ kind: 'info', text: friendShareNotice(f.name, on) });
          } catch (e) {
            share.checked = !on;
            throw e;
          } finally {
            share.disabled = false;
          }
        });
      });
      remove.addEventListener('click', () =>
        void run(async () => {
          remove.disabled = true;
          await api.removeFriend(f.id);
          notify({ kind: 'info', text: `${f.name} removed. You no longer see each other’s lists.` });
          await load();
          void cache.refresh();
        }),
      );
      friendsBox.append(
        el(
          'div',
          { class: 'friend-row', 'data-testid': 'friend' },
          el('div', { class: 'friend-name' }, el('strong', null, f.name), el('div', { class: 'small muted' }, `friends since ${fmtDate(f.since)}`)),
          el('label', { class: 'friend-share' }, el('span', { class: 'small' }, `Share with ${f.name}`), share),
          remove,
        ),
      );
    }
  };

  const load = async () => {
    try {
      const res = await api.listFriends();
      renderInvites(res.invites);
      renderFriends(res.friends);
      status.textContent = '';
    } catch (e) {
      status.textContent = `Could not load your friends: ${describeApiError(e)}`;
    }
  };

  // Add a friend
  const shareNote = el('p', { class: 'small muted', 'data-testid': 'invite-share-note' }, inviteShareNote(ctx.sharing.enabled));
  const email = el('input', { type: 'email', autocomplete: 'off', placeholder: 'Friend’s email', required: true, 'aria-label': 'Friend’s email', 'data-testid': 'invite-email' });
  const send = el('button', { class: 'btn small', type: 'submit', 'data-testid': 'invite-send' }, 'Send invite');
  const inviteForm = el('form', { class: 'stack' }, el('h3', null, 'Add a friend'), el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:1;margin:0' }, email), send), shareNote, el('p', { class: 'small muted' }, 'Members accept on My account. Others get a sign-up link; you’re friends once Sabih approves them. Friends see your name, never your email. 10 invites a day, valid 30 days.'));
  inviteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!inviteForm.reportValidity()) return;
    void run(async () => {
      send.disabled = true;
      try {
        const res = await api.inviteFriend(email.value.trim());
        email.value = '';
        notify({ kind: 'info', text: res.message });
      } finally {
        send.disabled = false;
      }
    });
  });

  root.append(
    el('p', { class: 'small muted', 'data-testid': 'share-consent' }, SHARING_CONSENT_TEXT),
    el('p', { class: 'small muted' }, 'Friends’ birds show as “Spotted by” on Species. Nothing of yours is shared until you turn on sharing; each friend’s switch controls just them.'),
    invitesBox,
    friendsBox,
    inviteForm,
    status,
  );
  void load();
  return { el: root, dispose: () => undefined, sharingChanged: () => (shareNote.textContent = inviteShareNote(ctx.sharing.enabled)) };
}

/**
 * The "Share my species list" switch as a Settings row, with the status line under it
 * (DECISIONS.md #44). The long consent text stays in the friends panel, which the
 * Account screen keeps behind a collapsed row.
 */
export function sharingRow(ctx: ViewContext, onChange?: () => void): { el: HTMLElement; dispose: () => void } {
  const { sharing, notify } = ctx;
  const input = el('input', { type: 'checkbox', checked: sharing.enabled, 'data-testid': 'share-species' });
  const note = textRow(shareStatusText(sharing.enabled, sharing.lastError), { testId: 'share-status' });
  let busy = false;
  input.addEventListener('change', () => {
    if (busy) return;
    const on = input.checked;
    busy = true;
    input.disabled = true;
    void (async () => {
      try {
        await sharing.setEnabled(on);
        notify({ kind: 'info', text: on ? 'Sharing is on. Your species list was uploaded.' : 'Sharing is off. Your list was removed from the server.' });
      } catch (e) {
        input.checked = sharing.enabled;
        notify({ kind: 'error', text: describeApiError(e) });
      } finally {
        busy = false;
        input.disabled = false;
        note.textContent = shareStatusText(sharing.enabled, sharing.lastError);
        onChange?.();
      }
    })();
  });
  return {
    el: el('div', { class: 'contents-row' }, switchRow('Share my species list', input, { hint: 'Friends see species and dates only' }), note),
    dispose: () => undefined,
  };
}
