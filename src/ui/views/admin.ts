import { describeApiError, type AdminUser } from '../../api/client';
import type { View, ViewContext } from '../app';
import { el, fmtDateTime } from '../dom';

export function adminView(ctx: ViewContext): View {
  const { api } = ctx;
  const root = el('div', null);
  const list = el('div', { class: 'list', 'data-testid': 'admin-users' });
  const status = el('div', { class: 'small muted' }, '');

  const load = async () => {
    const me = api.user;
    if (!me || me.role !== 'admin' || me.status !== 'approved') {
      root.replaceChildren(el('section', { class: 'card' }, el('h2', null, 'Admin'), el('p', null, 'Sign in as the admin account from Settings to manage members.'), el('a', { class: 'btn small', href: '#/settings' }, 'Go to Settings')));
      return;
    }
    root.replaceChildren(el('section', { class: 'card' }, el('h2', null, 'Members'), el('p', { class: 'small muted' }, 'Approve people you know. Rejecting or disabling signs them out everywhere.'), status), list);
    status.textContent = 'Loading…';
    try {
      const { users } = await api.adminListUsers();
      render(users);
      status.textContent = `${users.length} account${users.length === 1 ? '' : 's'}`;
    } catch (e) {
      status.textContent = describeApiError(e);
    }
  };

  const render = (users: AdminUser[]) => {
    list.replaceChildren();
    for (const u of users) {
      const actions = el('div', { class: 'row' });
      const mk = (label: string, action: 'approve' | 'reject' | 'disable', cls = '') => {
        const b = el('button', { class: `btn small ${cls}`, type: 'button' }, label);
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await api.adminSetStatus(u.id, action);
            await load();
          } catch (e) {
            status.textContent = describeApiError(e);
            b.disabled = false;
          }
        });
        return b;
      };
      const self = u.id === api.user?.id;
      if (!self) {
        if (u.status !== 'approved') actions.appendChild(mk('Approve', 'approve', 'primary'));
        if (u.status === 'pending') actions.appendChild(mk('Reject', 'reject', 'danger'));
        if (u.status === 'approved') actions.appendChild(mk('Disable', 'disable', 'danger'));
      }
      list.appendChild(el('div', { class: 'list-item' }, el('div', { class: 'title' }, u.email, self ? ' (you)' : ''), el('div', { class: 'small muted' }, `${u.status} · ${u.role} · joined ${fmtDateTime(new Date(u.createdAt).getTime())}${u.emailVerified ? '' : ' · email not yet confirmed'}`), actions));
    }
  };

  void load();
  const unsub = api.on('change', () => void load());
  return { el: root, dispose: unsub };
}
