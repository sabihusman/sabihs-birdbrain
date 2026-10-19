import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';
import { AppController } from './app/controller';
import { mountApp } from './ui/app';
import { registerPwa } from './pwa';
import { ApiClient } from './api/client';
import { API_BASE_URL } from './api/config';
import { isMember } from './app/access';
import { applyTheme, readStoredTheme } from './theme/theme';

// The inline script in index.html already set data-theme before first paint; this keeps the meta colour in step.
applyTheme(readStoredTheme());

const baseUrl = import.meta.env.BASE_URL;
const controller = new AppController(baseUrl);
const api = new ApiClient(API_BASE_URL);
// Species clips are collected only while an approved member is signed in (decided from the cached session, so it works offline).
controller.setClipsEnabled(isMember(api.user));
api.on('change', (user) => controller.setClipsEnabled(isMember(user)));
mountApp(document.getElementById('app')!, controller, api);
void api.refresh();
registerPwa((notice) => controller.emit('notice', notice));
void controller.init();
