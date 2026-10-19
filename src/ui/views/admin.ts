import { describeApiError, type AdminUser, type AskCostDay, type AskCostSummary } from '../../api/client';
import type { View, ViewContext } from '../app';
import { el, fmtDateTime } from '../dom';

export function adminView(ctx: ViewContext): View {
  const { api } = ctx;
  const root = el('div', null);
  const list = el('div', { class: 'list', 'data-testid': 'admin-users' });
  const status = el('div', { class: 'small muted' }, '');
  const costStatus = el('div', { class: 'small muted' }, '');
  const costTable = el('div', { class: 'table-wrap', 'data-testid': 'admin-ask-costs' });
  const providerTable = el('div', { class: 'table-wrap', 'data-testid': 'admin-ask-providers' });

  const load = async () => {
    const me = api.user;
    if (!me || me.role !== 'admin' || me.status !== 'approved') {
      root.replaceChildren(el('section', { class: 'card' }, el('h2', null, 'Admin'), el('p', null, 'Sign in as the admin account from Settings to manage members.'), el('a', { class: 'btn small', href: '#/settings' }, 'Go to Settings')));
      return;
    }
    root.replaceChildren(
      el('section', { class: 'card' }, el('h2', null, 'Members'), el('p', { class: 'small muted' }, 'Approve people you know. Rejecting or disabling signs them out everywhere.'), status),
      list,
      el('section', { class: 'card' }, el('h2', null, 'Ask costs'), el('p', { class: 'small muted' }, 'Which service answered over the last 30 days, then the estimated Gemini spend per UTC day from token counts and list prices. Ollama Cloud usage counts against its plan allowance, not a price. Cache hits cost nothing.'), providerTable, costStatus, costTable),
    );
    status.textContent = 'Loading…';
    costStatus.textContent = 'Loading…';
    const [usersResult, costsResult] = await Promise.allSettled([api.adminListUsers(), api.adminAskCosts()]);
    if (usersResult.status === 'fulfilled') {
      render(usersResult.value.users);
      status.textContent = `${usersResult.value.users.length} account${usersResult.value.users.length === 1 ? '' : 's'}`;
    } else status.textContent = describeApiError(usersResult.reason);
    if (costsResult.status === 'fulfilled') {
      renderProviders(costsResult.value);
      renderCosts(costsResult.value.model, costsResult.value.days);
    } else costStatus.textContent = describeApiError(costsResult.reason);
  };

  /** One row per provider: answers given, how many came after a fallback, tokens. */
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
