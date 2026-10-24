import { ApiError, describeApiError, type AdminUser, type AskCostDay, type AskCostSummary } from '../../api/client';
import { ADMIN_ONLY_MESSAGE, canManageUsers } from '../../app/access';
import type { View, ViewContext } from '../app';
import { linkRow, rowGroup } from '../components/rows';
import { el } from '../dom';

/** Shown instead of either admin page to anyone but the approved admin; the server answers 403 regardless. */
function adminOnly(title: string): HTMLElement {
  return el('section', { class: 'card', 'data-testid': 'admin-only' }, el('h2', null, title), el('p', null, ADMIN_ONLY_MESSAGE), el('a', { class: 'btn small', href: '#/settings' }, 'Go to Settings'));
}

/** Ask costs (#/admin): provider totals, the monthly Gemini cap and the per-day spend. Reached from User management. */
export function adminView(ctx: ViewContext): View {
  const { api } = ctx;
  const root = el('div', null);
  const costStatus = el('div', { class: 'small muted' }, '');
  const capLine = el('p', { class: 'cap-line', 'data-testid': 'admin-gemini-cap' }, '');
  const costTable = el('div', { class: 'table-wrap', 'data-testid': 'admin-ask-costs' });
  const providerTable = el('div', { class: 'table-wrap', 'data-testid': 'admin-ask-providers' });

  const load = async () => {
    if (!canManageUsers(api.user)) {
      root.replaceChildren(adminOnly('Ask costs'));
      return;
    }
    root.replaceChildren(
      el('div', { class: 'row' }, el('a', { class: 'btn small', href: '#/admin/users', 'data-testid': 'to-user-management' }, '‹ User management')),
      el('section', { class: 'card' }, el('h2', null, 'Ask costs'), el('p', { class: 'small muted' }, 'Which service answered over the last 30 days, then the estimated Gemini spend per UTC day from token counts and list prices. Ollama Cloud usage counts against its plan allowance, not a price. Cache hits cost nothing.'), providerTable, capLine, costStatus, costTable),
    );
    costStatus.textContent = 'Loading…';
    try {
      const summary = await api.adminAskCosts();
      renderProviders(summary);
      renderCosts(summary.model, summary.days);
      renderCap(summary.month);
    } catch (e) {
      costStatus.textContent = describeApiError(e);
    }
  };

  /** One row per provider: answers given, how many came after a fallback, tokens. */
  const renderCap = (m: AskCostSummary['month']) => {
    if (!m) {
      capLine.textContent = '';
      return;
    }
    const cap = m.capMicros > 0 ? fmtUsd(m.capMicros) : 'off (Gemini disabled)';
    const alertList = m.alertsSent.map((a) => a + '%').join(', ');
    const alerts = m.alertsSent.length ? ' · alerts sent: ' + alertList : '';
    const reached = m.capMicros > 0 && m.spentMicros >= m.capMicros;
    const head = 'Gemini this month (' + m.month + '): ' + fmtUsd(m.spentMicros) + ' of the ' + cap + ' cap';
    capLine.textContent = reached ? head + ' · cap reached, Gemini is skipped until next month' + alerts : head + ' (' + m.percent + '%)' + alerts;
  };

  const renderProviders = (summary: AskCostSummary) => {
    providerTable.replaceChildren();
    const rows = providerRows(summary);
    if (rows.length === 0) return;
    const row = (cells: string[], tag: 'th' | 'td' = 'td') => el('tr', null, ...cells.map((c, i) => el(tag, { class: i < 2 ? '' : 'num' }, c)));
    providerTable.appendChild(el('table', { class: 'cost-table' }, el('thead', null, row(['Provider', 'Model', 'Answers', 'After fallback', 'Prompt tokens', 'Answer tokens'], 'th')), el('tbody', null, ...rows.map((r) => row([r.provider, r.model, String(r.requests), String(r.fallbacks), String(r.promptTokens), String(r.answerTokens)])))));
  };

  const renderCosts = (model: string, days: AskCostDay[]) => {
    costTable.replaceChildren();
    if (days.length === 0) {
      costStatus.textContent = `No questions in the last 30 days (model ${model}).`;
      return;
    }
    const total = sumCostDays(days);
    costStatus.textContent = `Model ${model} · ${total.requests} model call${total.requests === 1 ? '' : 's'}, ${total.cacheHits} cache hit${total.cacheHits === 1 ? '' : 's'}, ${fmtUsd(total.costMicros)} in total${total.unpricedRequests ? ` (${total.unpricedRequests} unpriced)` : ''}`;
    const row = (cells: string[], tag: 'th' | 'td' = 'td') => el('tr', null, ...cells.map((c, i) => el(tag, { class: i === 0 ? '' : 'num' }, c)));
    const body = el('tbody', null, ...days.map((d) => row([d.day, String(d.requests), String(d.cacheHits), String(d.promptTokens), String(d.answerTokens + d.thinkingTokens), fmtUsd(d.costMicros)])));
    body.appendChild(row(['Total', String(total.requests), String(total.cacheHits), String(total.promptTokens), String(total.answerTokens + total.thinkingTokens), fmtUsd(total.costMicros)], 'th'));
    costTable.appendChild(el('table', { class: 'cost-table' }, el('thead', null, row(['Day', 'Calls', 'Cached', 'Prompt tokens', 'Output tokens', 'USD'], 'th')), body));
  };

  void load();
  const unsub = api.on('change', () => void load());
  return { el: root, dispose: unsub };
}

export type UserAction = 'approve' | 'reject' | 'disable' | 'reset' | 'delete';

/** The buttons a user row gets, by status; none for the admin's own account. */
export function userActions(u: Pick<AdminUser, 'status' | 'role'>, self: boolean): UserAction[] {
  if (self || u.role === 'admin') return [];
  const out: UserAction[] = [];
  if (u.status !== 'approved') out.push('approve');
  if (u.status === 'pending') out.push('reject');
  if (u.status === 'approved') out.push('disable');
  out.push('reset', 'delete');
  return out;
}

export const ACTION_LABEL: Record<UserAction, string> = { approve: 'Approve', reject: 'Reject', disable: 'Disable', reset: 'Send reset link', delete: 'Delete' };

/** The question asked before each action, in plain words. */
export function confirmText(action: UserAction, email: string): string {
  switch (action) {
    case 'approve':
      return `Approve ${email}? They get member features the next time they sign in, and an email saying so.`;
    case 'reject':
      return `Reject ${email}? They are signed out and cannot use member features.`;
    case 'disable':
      return `Disable ${email}? They are signed out everywhere and cannot sign in until you approve them again.`;
    case 'reset':
      return `Email ${email} a link to choose a new password? Their password stays the same until they use the link. You will not see the new one.`;
    case 'delete':
      return `Delete ${email} for good? Their sign-in, sessions, friends, invites and shared species list are removed at once. There is no undo. Type their email to confirm.`;
  }
}

/** What happened, in plain words, after a successful action. */
export function resultText(action: UserAction, email: string, emailed?: boolean): string {
  switch (action) {
    case 'approve':
      return emailed === false ? `${email} is approved, but the email could not be sent.` : `${email} is approved.`;
    case 'reject':
      return `${email} was rejected.`;
    case 'disable':
      return `${email} is disabled and signed out.`;
    case 'reset':
      return emailed ? `Reset link sent to ${email}. It works once, for 60 minutes.` : 'The reset link could not be emailed. Nothing was changed. Try again.';
    case 'delete':
      return emailed ? `${email} was deleted. A confirmation email was sent to them.` : `${email} was deleted. The confirmation email could not be sent.`;
  }
}

/** The delete button enables only when the typed text is the user's address (case and outer spaces ignored, as on the server). */
export function deleteConfirmed(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

const STATUS_LABEL: Record<AdminUser['status'], string> = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected', disabled: 'Disabled' };

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return 'That account no longer exists.';
  return describeApiError(e);
}

/**
 * User management (#/admin/users), admin only (DECISIONS.md #61): every account
 * with its address, display name, status and sign-up date, and per account
 * Approve / Reject / Disable, Reset password and Delete. Each action asks first,
 * inside the row; Delete also wants the address typed again.
 */
export function userManagementView(ctx: ViewContext): View {
  const { api } = ctx;
  const root = el('div', null);
  const list = el('div', { class: 'list', 'data-testid': 'admin-users' });
  const count = el('div', { class: 'small muted' }, '');
  const notice = el('div', { class: 'notice info', role: 'status', 'aria-live': 'polite', 'data-testid': 'admin-result' });
  let busy = false;

  const say = (text: string) => {
    notice.textContent = text;
    notice.hidden = !text;
  };

  const load = async () => {
    if (!canManageUsers(api.user)) {
      root.replaceChildren(adminOnly('User management'));
      return;
    }
    root.replaceChildren(
      el('div', { class: 'row' }, el('a', { class: 'btn small', href: '#/settings', 'data-testid': 'to-settings' }, '‹ Settings')),
      el('section', { class: 'card' }, el('h2', null, 'User management'), el('p', { class: 'small muted' }, 'New accounts wait here until you approve them. Rejecting or disabling signs them out everywhere.'), count),
      notice,
      list,
      el('section', { class: 'card' }, rowGroup(null, linkRow('Ask costs', '#/admin', { hint: 'Which service answered and what it cost', testId: 'admin-costs-link' }))),
    );
    notice.hidden = !notice.textContent;
    count.textContent = 'Loading…';
    try {
      const { users } = await api.adminListUsers();
      count.textContent = `${users.length} account${users.length === 1 ? '' : 's'}`;
      render(users);
    } catch (e) {
      count.textContent = errorText(e);
    }
  };

  const run = async (u: AdminUser, action: UserAction, confirmValue = '') => {
    if (busy) return;
    busy = true;
    say('Working…');
    try {
      let emailed: boolean | undefined;
      if (action === 'reset') emailed = (await api.adminResetPassword(u.id)).emailed;
      else if (action === 'delete') emailed = (await api.adminDeleteUser(u.id, confirmValue)).emailed;
      else emailed = (await api.adminSetStatus(u.id, action)).emailed;
      say(resultText(action, u.email, emailed));
    } catch (e) {
      say(errorText(e));
    } finally {
      busy = false;
    }
    await load();
  };

  /** Replace the row's buttons with the question, a confirm button and Cancel. */
  const askFirst = (u: AdminUser, action: UserAction, host: HTMLElement, buttons: HTMLElement) => {
    const danger = action !== 'approve';
    const go = el('button', { class: `btn small ${danger ? 'danger' : 'primary'}`, type: 'button', 'data-testid': `confirm-${action}` }, action === 'delete' ? 'Delete for good' : ACTION_LABEL[action]);
    const cancel = el('button', { class: 'btn small', type: 'button', 'data-testid': 'confirm-cancel' }, 'Cancel');
    const parts: HTMLElement[] = [el('p', { class: 'small' }, confirmText(action, u.email))];
    let typed: HTMLInputElement | null = null;
    if (action === 'delete') {
      typed = el('input', { type: 'email', autocomplete: 'off', spellcheck: false, placeholder: u.email, 'aria-label': `Type ${u.email} to confirm`, 'data-testid': 'delete-email' });
      go.disabled = true;
      const t = typed;
      t.addEventListener('input', () => {
        go.disabled = !deleteConfirmed(t.value, u.email);
      });
      parts.push(el('div', { class: 'field', style: 'margin:0' }, el('label', null, 'Their email'), typed));
    }
    parts.push(el('div', { class: 'row' }, go, cancel));
    const panel = el('div', { class: 'stack confirm-panel', 'data-testid': 'confirm-panel' }, ...parts);
    go.addEventListener('click', () => {
      if (typed && !deleteConfirmed(typed.value, u.email)) return;
      go.disabled = cancel.disabled = true;
      void run(u, action, typed?.value.trim() ?? '');
    });
    cancel.addEventListener('click', () => {
      host.replaceChildren(buttons);
    });
    host.replaceChildren(panel);
    (typed ?? go).focus();
  };

  const render = (users: AdminUser[]) => {
    list.replaceChildren();
    for (const u of users) {
      const self = u.id === api.user?.id;
      const host = el('div', { class: 'stack' });
      const buttons = el('div', { class: 'row' });
      for (const action of userActions(u, self)) {
        const cls = action === 'approve' ? 'primary' : action === 'reset' ? '' : 'danger';
        const b = el('button', { class: `btn small ${cls}`, type: 'button', 'data-testid': `user-${action}` }, ACTION_LABEL[action]);
        b.addEventListener('click', () => askFirst(u, action, host, buttons));
        buttons.appendChild(b);
      }
      host.appendChild(self ? el('p', { class: 'small muted' }, 'Your own account. Change your password on My account.') : buttons);
      const joined = new Date(u.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
      list.appendChild(
        el(
          'div',
          { class: 'list-item user-item', 'data-testid': 'admin-user' },
          el('div', { class: 'title user-email' }, u.email, self ? ' (you)' : ''),
          el('div', { class: 'small user-name' }, u.name ? `Name: ${u.name}` : 'No display name'),
          el('div', { class: 'small muted', 'data-testid': 'admin-user-status' }, `${STATUS_LABEL[u.status]}${u.role === 'admin' ? ' · admin' : ''} · joined ${joined}${u.emailVerified ? '' : ' · email not yet confirmed'}`),
          host,
        ),
      );
    }
  };

  say('');
  void load();
  const unsub = api.on('change', () => void load());
  return { el: root, dispose: unsub };
}

/** The provider rows in configured order (a configured provider with no answers still shows a zero row); unknown models as "?". */
export function providerRows(summary: Pick<AskCostSummary, 'providerOrder' | 'models' | 'providers'>): Array<{ provider: string; model: string; requests: number; fallbacks: number; promptTokens: number; answerTokens: number }> {
  const totals = summary.providers ?? [];
  const order = summary.providerOrder ?? totals.map((t) => t.provider);
  const names = [...order, ...totals.map((t) => t.provider).filter((p) => !order.includes(p))];
  return names.map((provider) => {
    const t = totals.find((x) => x.provider === provider);
    return { provider, model: summary.models?.[provider] ?? '?', requests: t?.requests ?? 0, fallbacks: t?.fallbacks ?? 0, promptTokens: t?.promptTokens ?? 0, answerTokens: t?.answerTokens ?? 0 };
  });
}

/** Micro-dollars as "$0.0123" (four decimals: a day's spend is cents at most). */
export function fmtUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

export function sumCostDays(days: ReadonlyArray<AskCostDay>): AskCostDay {
  const t: AskCostDay = { day: 'total', requests: 0, promptTokens: 0, answerTokens: 0, thinkingTokens: 0, cachedTokens: 0, costMicros: 0, unpricedRequests: 0, cacheHits: 0 };
  for (const d of days) {
    t.requests += d.requests;
    t.promptTokens += d.promptTokens;
    t.answerTokens += d.answerTokens;
    t.thinkingTokens += d.thinkingTokens;
    t.cachedTokens += d.cachedTokens;
    t.costMicros += d.costMicros;
    t.unpricedRequests += d.unpricedRequests;
    t.cacheHits += d.cacheHits;
  }
  return t;
}
