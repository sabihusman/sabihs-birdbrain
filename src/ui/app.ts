import type { AppController, Notice } from '../app/controller';
import { el, clear } from './dom';
import { hrefFor, parseHash, type Route } from './router';
import { listenView } from './views/listen';
import { recordingsView, recordingDetailView } from './views/recordings';
import { speciesListView, speciesDetailView } from './views/species';
import { speciesHistoryView } from './views/species-history';
import { mapView } from './views/map';
import { settingsView } from './views/settings';
import { helpView } from './views/help';
import { adminView } from './views/admin';
import type { ApiClient } from '../api/client';
import { applyTheme, currentTheme, otherTheme, storeTheme } from '../theme/theme';
import { listenStatus } from './status';

export interface View {
  el: HTMLElement;
  dispose?: () => void;
}

export interface ViewContext {
  controller: AppController;
  api: ApiClient;
  notify: (n: Notice) => void;
}

const ICONS: Record<string, string> = {
  listen: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  recordings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>',
  species: '<svg viewBox="0 0 24 24"><path d="M4 20c2-8 8-13 16-14-1 8-6 14-14 14H4zM4 20l6-6"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

const TABS: Array<{ route: Route; label: string; icon: string }> = [
  { route: { name: 'listen' }, label: 'Listen', icon: 'listen' },
  { route: { name: 'recordings' }, label: 'Recordings', icon: 'recordings' },
  { route: { name: 'species' }, label: 'Species', icon: 'species' },
  { route: { name: 'map' }, label: 'Map', icon: 'map' },
  { route: { name: 'settings' }, label: 'Settings', icon: 'settings' },
];

function tabGroup(route: Route): string {
  switch (route.name) {
    case 'recording':
      return 'recordings';
    case 'species-detail':
    case 'species-history':
      return 'species';
    case 'help':
    case 'admin':
      return 'settings';
    default:
      return route.name;
  }
}

export function mountApp(root: HTMLElement, controller: AppController, api: ApiClient): void {
  const modelPill = el('span', { class: 'model-pill', 'data-testid': 'model-status' }, 'Loading model…');
  const themeToggle = el('button', { class: 'theme-toggle', type: 'button', 'data-testid': 'theme-toggle' });
  const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const renderToggle = () => {
    const t = currentTheme();
    themeToggle.innerHTML = t === 'dark' ? SUN : MOON;
    themeToggle.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    themeToggle.title = themeToggle.getAttribute('aria-label') ?? '';
  };
  themeToggle.addEventListener('click', () => {
    const next = otherTheme(currentTheme());
    applyTheme(next);
    storeTheme(next);
    renderToggle();
  });
  renderToggle();
  const header = el('header', { class: 'app-header' }, el('img', { src: `${controller.baseUrl}icons/icon-192.png`, alt: '' }), el('h1', null, 'Sabih’s Birdbrain'), modelPill, themeToggle);
  const notices = el('div', { class: 'notices', 'aria-live': 'polite' });
  const main = el('main', { class: 'view' });
  const tabs = el('nav', { class: 'tabs', 'aria-label': 'Main' });
  const tabLinks = new Map<string, HTMLAnchorElement>();
  for (const t of TABS) {
    const a = el('a', { href: hrefFor(t.route), 'aria-label': t.label });
    a.innerHTML = ICONS[t.icon];
    a.appendChild(el('span', null, t.label));
    tabLinks.set(t.route.name, a);
    tabs.appendChild(a);
  }
  root.replaceChildren(el('div', { class: 'app' }, header, notices, main, tabs));

  const notify = (n: Notice) => {
    const node = el('div', { class: `notice ${n.kind}`, role: n.kind === 'error' ? 'alert' : 'status' }, n.text);
    notices.appendChild(node);
    setTimeout(() => node.remove(), n.kind === 'error' ? 12000 : 6000);
  };
  controller.on('notice', notify);
  // Status pill (DESIGN_GUIDE.md §5): text always present, dot colour by tone.
  const renderPill = () => {
    const st = listenStatus(controller);
    const model = controller.inference.getStatus();
    modelPill.textContent = st.status === 'ready' && model.backend ? `${st.pill} · ${model.backend}` : st.pill;
    modelPill.className = `model-pill ${st.status} tone-${st.tone}`;
  };
  controller.on('model', renderPill);
  controller.on('engine', renderPill);
  controller.on('notice', renderPill);
  window.addEventListener('online', renderPill);
  window.addEventListener('offline', renderPill);
  renderPill();

  const ctx: ViewContext = { controller, api, notify };
  let current: View | null = null;

  const render = () => {
    const route = parseHash(location.hash);
    current?.dispose?.();
    clear(main);
    for (const [name, a] of tabLinks) a.classList.toggle('active', name === tabGroup(route));
    switch (route.name) {
      case 'listen':
        current = listenView(ctx);
        break;
      case 'recordings':
        current = recordingsView(ctx);
        break;
      case 'recording':
        current = recordingDetailView(ctx, route.id);
        break;
      case 'species':
        current = speciesListView(ctx);
        break;
      case 'species-detail':
        current = speciesDetailView(ctx, route.scientific);
        break;
      case 'species-history':
        current = speciesHistoryView(ctx, route.scientific);
        break;
      case 'map':
        current = mapView(ctx);
        break;
      case 'settings':
        current = settingsView(ctx);
        break;
      case 'help':
        current = helpView(ctx);
        break;
      case 'admin':
        current = adminView(ctx);
        break;
    }
    main.appendChild(current.el);
    window.scrollTo(0, 0);
  };
  window.addEventListener('hashchange', render);
  render();
}
