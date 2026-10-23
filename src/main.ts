import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';
import { AppController } from './app/controller';
import { mountApp, showUpdateBanner } from './ui/app';
import { registerPwa } from './pwa';
import { ApiClient } from './api/client';
import { API_BASE_URL } from './api/config';
import { isMember } from './app/access';
import { applyTheme, readStoredTheme } from './theme/theme';
import { readVisitSignals, safeLocalStorage, shouldShowWelcome } from './app/first-visit';
import { MODEL_BASE_URL } from './model/model-source';

// The inline script in index.html already set data-theme before first paint; this keeps the meta colour in step.
applyTheme(readStoredTheme());

async function boot(): Promise<void> {
  const baseUrl = import.meta.env.BASE_URL;
  const controller = new AppController(baseUrl);
  const api = new ApiClient(API_BASE_URL);
  // First visit (no settings, no flag, no cached model): the Listen view shows the welcome layer
  // and nothing downloads until the visitor taps "Start identifying" (DECISIONS.md #68). Decided
  // before the first paint so the loading state never flashes first.
  const signals = await readVisitSignals(safeLocalStorage(), typeof caches === 'undefined' ? undefined : caches, MODEL_BASE_URL);
  controller.setWelcomePending(shouldShowWelcome(signals));
  // Species clips are collected only while an approved member is signed in (decided from the cached session, so it works offline).
  controller.setClipsEnabled(isMember(api.user));
  api.on('change', (user) => controller.setClipsEnabled(isMember(user)));
  mountApp(document.getElementById('app')!, controller, api);
  void api.refresh();
  registerPwa({ notify: (notice) => controller.emit('notice', notice), onUpdateAvailable: (apply) => showUpdateBanner(apply) });
  void controller.init();
}

void boot();
