import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';
import { AppController } from './app/controller';
import { mountApp } from './ui/app';
import { registerPwa } from './pwa';
import { ApiClient } from './api/client';
import { API_BASE_URL } from './api/config';

const baseUrl = import.meta.env.BASE_URL;
const controller = new AppController(baseUrl);
const api = new ApiClient(API_BASE_URL);
mountApp(document.getElementById('app')!, controller, api);
void api.refresh();
registerPwa((notice) => controller.emit('notice', notice));
void controller.init();
