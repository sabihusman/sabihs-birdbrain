import { describeApiError, type UsageRange, type UsageReport } from '../../api/client';
import { ADMIN_ONLY_MESSAGE, canManageUsers } from '../../app/access';
import type { View, ViewContext } from '../app';
import { el } from '../dom';
import { backendLabel, deviceLabel, groupCounts, layoutLabel, micLabel, screenLabel, shortDuration, timeZoneLabel, updatedText } from '../usage-labels';

/**
 * Admin › Usage (#/admin/usage, DECISIONS.md #121): the anonymous usage counts (#120), as in the mockups Sabih
 * approved on Nov 10. The server reads them from PostHog; this page never talks to PostHog. Reached from User
 * management. One column on a phone, cards three across on a wide screen.
 */
const RANGES: ReadonlyArray<[UsageRange, string]> = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];
const RANGE_WORDS: Record<UsageRange, string> = { today: 'today', '7d': '7 days', '30d': '30 days' };
const SVG = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(title: string, sub: string | null, testId: string, ...body: Array<Node | null>): HTMLElement {
  return el('section', { class: 'card usage-card', 'data-testid': testId }, el('h2', null, title), sub ? el('p', { class: 'small muted usage-sub' }, sub) : null, ...body);
}

const failedNote = () => el('p', { class: 'small muted' }, 'Couldn’t load this from PostHog. It retries on the next refresh.');
const emptyNote = (text: string) => el('p', { class: 'small muted' }, text);

/** One bar per row, length relative to the largest; the value as text, and on hover. */
export function barList(rows: ReadonlyArray<{ label: string; count: number }>, unit = ''): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return el(
    'div',
    { class: 'ubars' },
    ...rows.flatMap((r) => [
      el('span', { class: 'ubar-label' }, r.label),
      el('div', { class: 'ubar-track', title: `${r.label}: ${r.count}${unit}` }, el('div', { class: 'ubar', style: `width:${Math.max(3, (r.count / max) * 100).toFixed(1)}%` })),
      el('span', { class: 'ubar-value' }, `${r.count}${unit}`),
    ]),
  );
}

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Listens per day, one line; a dot per day with its value on hover, today labelled. */
export function lineChart(days: ReadonlyArray<{ day: string; listens: number }>, width: number): SVGSVGElement {
  const W = Math.max(260, Math.round(width));
  const H = W > 600 ? 210 : 130;
  const left = 26;
  const top = 12;
  const bottom = 18;
  const peak = Math.max(4, ...days.map((d) => d.listens));
  const step = Math.pow(10, Math.floor(Math.log10(peak)));
  const max = Math.ceil(peak / step) * step;
  const y = (v: number) => H - bottom - (v / max) * (H - bottom - top);
  const x = (i: number) => left + (i * (W - left - 8)) / Math.max(1, days.length - 1);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Listens per day, last ${days.length} days`, class: 'uline' });
  for (const g of [0, max / 2, max]) {
    root.appendChild(svg('line', { x1: left, x2: W - 4, y1: y(g), y2: y(g), class: 'uline-grid' }));
    root.appendChild(svg('text', { x: 0, y: y(g) + 3, class: 'uline-axis' }, String(Math.round(g))));
  }
  root.appendChild(svg('polyline', { points: days.map((d, i) => `${x(i).toFixed(1)},${y(d.listens).toFixed(1)}`).join(' '), class: 'uline-path' }));
  days.forEach((d, i) => {
    const hit = svg('circle', { cx: x(i), cy: y(d.listens), r: 8, class: 'uline-hit' });
    hit.appendChild(svg('title', {}, `${shortDay(d.day)}: ${d.listens} listen${d.listens === 1 ? '' : 's'}`));
    root.appendChild(hit);
  });
  const last = days[days.length - 1];
  if (last) {
    root.appendChild(svg('circle', { cx: x(days.length - 1), cy: y(last.listens), r: 4, class: 'uline-end' }));
    root.appendChild(svg('text', { x: x(days.length - 1) - 8, y: y(last.listens) + 4, 'text-anchor': 'end', class: 'uline-today' }, `${last.listens} today`));
    root.appendChild(svg('text', { x: left, y: H - 3, class: 'uline-axis' }, shortDay(days[0].day)));
    root.appendChild(svg('text', { x: W - 4, y: H - 3, 'text-anchor': 'end', class: 'uline-axis' }, shortDay(last.day)));
  }
  return root;
}

function rowsTable(rows: ReadonlyArray<[string, string]>): HTMLElement {
  return el('table', { class: 'usage-table' }, el('tbody', null, ...rows.map(([k, v]) => el('tr', null, el('td', null, k), el('td', { class: 'num' }, v)))));
}

export function usageView(ctx: ViewContext): View {
  const { api } = ctx;
  const root = el('div', { class: 'usage-page', 'data-testid': 'usage-page' });
  let range: UsageRange = '7d';
  let report: UsageReport | null = null;
  let lineHost: HTMLElement | null = null;
  let disposed = false;

  const status = el('p', { class: 'small muted', 'data-testid': 'usage-status' }, 'Loading…');
  const chips = el('div', { class: 'usage-chips', role: 'group', 'aria-label': 'Period' });
  const body = el('div', { class: 'usage-body' });
  for (const [r, label] of RANGES) {
    const b = el('button', { type: 'button', class: 'usage-chip', 'data-range': r, 'aria-pressed': String(r === range) }, label);
    b.addEventListener('click', () => {
      if (r === range) return;
      range = r;
      for (const c of Array.from(chips.children)) c.setAttribute('aria-pressed', String((c as HTMLElement).dataset.range === range));
      void load();
    });
    chips.appendChild(b);
  }

  const drawLine = () => {
    if (!lineHost || !report) return;
    lineHost.replaceChildren(lineChart(report.days.slice(-14), lineHost.clientWidth || 320));
  };
  const onResize = () => drawLine();

  const render = (r: UsageReport) => {
    report = r;
    status.textContent = `Anonymous counts from PostHog, without Sabih’s own use. ${updatedText(r.updatedAt, new Date(), r.stale)}`;
    const failed = new Set(r.failed);
    const t = r.tiles;
    const tile = (n: string, label: string, testId: string) => el('div', { class: 'usage-tile', 'data-testid': testId }, el('div', { class: 'usage-n' }, n), el('div', { class: 'small muted' }, label));
    const tiles = el(
      'div',
      { class: 'usage-tiles' },
      tile(failed.has('days') || t.visitorsPerDay == null ? '–' : String(t.visitorsPerDay), range === 'today' ? 'visitors today' : 'visitors a day, on average¹', 'usage-visitors'),
      tile(failed.has('tiles') ? '–' : String(t.listens), 'listens started', 'usage-listens'),
      tile(failed.has('tiles') || t.foundShare == null ? '–' : `${Math.round(t.foundShare * 100)}%`, 'of listens found a bird', 'usage-found'),
      tile(failed.has('tiles') ? '–' : shortDuration(t.medianListenSec), 'typical listen (median)', 'usage-median'),
    );
    lineHost = el('div', { class: 'uline-host' });
    const nothing = (rows: unknown[], text: string) => (rows.length ? null : emptyNote(text));
    const words = RANGE_WORDS[range];
    const bd = failed.has('breakdowns');
    const screens = groupCounts(r.screens, screenLabel, 8);
    const layouts = groupCounts(r.layouts, layoutLabel);
    const backends = groupCounts(r.backends, backendLabel);
    const devices = groupCounts(r.devices, deviceLabel, 6);
    const zones = groupCounts(r.timeZones, timeZoneLabel, 6);
    const mic = groupCounts(r.micProblems, micLabel);
    const loadRows: Array<[string, string]> = failed.has('load')
      ? []
      : [
          ['First download', r.load.firstDownloadSec == null ? '–' : `${r.load.firstDownloadSec.toFixed(1)} s`],
          ['Already on the phone', r.load.cachedSec == null ? '–' : `${r.load.cachedSec.toFixed(1)} s`],
        ];
    if (!bd) loadRows.push(['Couldn’t run (old browser)', `${r.modelFailures.unsupported} visit${r.modelFailures.unsupported === 1 ? '' : 's'}`]);
    const errorRows: Array<[string, string]> = [...mic.map((m): [string, string] => [m.label, String(m.count)]), ['Model download failed', String(r.modelFailures.other)]];

    body.replaceChildren(
      tiles,
      el(
        'div',
        { class: 'usage-grid' },
        card('Listens per day', 'Last 14 days', 'usage-days', failed.has('days') ? failedNote() : lineHost),
        card('Screens opened', `Times each screen was opened, ${words}`, 'usage-screens', bd ? failedNote() : nothing(screens, 'No screens opened yet.') ?? barList(screens)),
        card('Listen layout used', 'Listens started, by layout', 'usage-layouts', bd ? failedNote() : nothing(layouts, 'No listens yet.') ?? barList(layouts)),
        card('Model', 'How phones ran BirdNET, and how long loading took (median)', 'usage-model', bd ? failedNote() : backends.length ? barList(backends) : emptyNote('The model hasn’t loaded yet.'), loadRows.length ? rowsTable(loadRows) : null),
        card('Devices', 'Visits by device and browser', 'usage-devices', bd ? failedNote() : nothing(devices, 'No visits yet.') ?? barList(devices)),
        card('Time zones', 'The phone’s time zone, the only hint of region', 'usage-zones', bd ? failedNote() : nothing(zones, 'No visits yet.') ?? barList(zones)),
        card('Errors', words === 'today' ? 'Today' : words.replace(/^./, (c) => c.toUpperCase()), 'usage-errors', bd ? failedNote() : rowsTable(errorRows)),
        card(
          'What this can’t show',
          null,
          'usage-cant',
          el('ul', { class: 'small usage-cant' }, el('li', null, 'Whether people come back next week. Nobody is recognised from one day to the next.'), el('li', null, 'Countries or cities. PostHog turns location lookup off in this mode.'), el('li', null, 'Which birds anyone heard, or where.')),
          el('p', { class: 'small muted' }, '¹ The same phone counts again each day, so add days up with care: a 7-day total counts a daily visitor 7 times.'),
        ),
      ),
    );
    requestAnimationFrame(drawLine);
  };

  const notSetUp = () =>
    body.replaceChildren(
      card(
        'Not set up yet',
        null,
        'usage-not-set-up',
        el('p', null, 'The server needs a read-only PostHog key to show these numbers.'),
        el('p', { class: 'small' }, 'On the server, add POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID to /opt/birdbrain/.env, then restart the API. The key never comes to this page.'),
      ),
    );

  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    status.textContent = 'Loading…';
    try {
      const r = await api.adminUsage(range);
      if (disposed || mine !== seq) return;
      if (!r.configured) {
        status.textContent = '';
        notSetUp();
      } else render(r);
    } catch (e) {
      if (disposed || mine !== seq) return;
      const retry = el('button', { type: 'button', class: 'btn small' }, 'Try again');
      retry.addEventListener('click', () => void load());
      status.textContent = '';
      body.replaceChildren(card('Couldn’t load', null, 'usage-error', el('p', null, (e as { code?: string }).code === 'usage_unavailable' ? 'PostHog didn’t answer. Try again in a few minutes.' : describeApiError(e)), el('div', { class: 'row' }, retry)));
    }
  };

  const show = () => {
    if (!canManageUsers(api.user)) {
      root.replaceChildren(el('section', { class: 'card', 'data-testid': 'admin-only' }, el('h2', null, 'Usage'), el('p', null, ADMIN_ONLY_MESSAGE), el('a', { class: 'btn small', href: '#/settings' }, 'Go to Settings')));
      return;
    }
    root.replaceChildren(el('div', { class: 'row' }, el('a', { class: 'btn small', href: '#/admin/users', 'data-testid': 'to-user-management' }, '‹ User management')), el('div', { class: 'usage-top' }, el('div', null, el('h1', null, 'Usage'), status), chips), body);
    void load();
  };

  show();
  window.addEventListener('resize', onResize);
  const unsub = api.on('change', show);
  return {
    el: root,
    dispose: () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      unsub();
    },
  };
}
