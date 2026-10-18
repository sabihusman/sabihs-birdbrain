import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';
import { AppController } from './app/controller';
import { mountApp } from './ui/app';
import { registerPwa } from './pwa';

const baseUrl = import.meta.env.BASE_URL;
const controller = new AppController(baseUrl);
mountApp(document.getElementById('app')!, controller);
registerPwa((notice) => controller.emit('notice', notice));
void controller.init();
