import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.heat';
import type { AppController } from '../../app/controller';
import { speciesColor } from '../../species/colors';
import { listDetections } from '../../storage/db';
import type { DetectionRecord } from '../../storage/types';
import type { View, ViewContext } from '../app';
import { el, fmtDateTime, pct } from '../dom';
import { speciesHref } from '../router';
import { locationBlock } from '../components/location-block';

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function baseMap(container: HTMLElement): L.Map {
  const map = L.map(container, { zoomControl: true, attributionControl: true });
  // One tile layer, served live from OSM; never cached or prefetched by the service worker.
  L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION, crossOrigin: true }).addTo(map);
  return map;
}

function markerFor(d: DetectionRecord, controller: AppController): L.CircleMarker {
  const color = speciesColor(d.scientific);
  const m = L.circleMarker([d.lat!, d.lon!], { radius: 8, color: '#fff', weight: 1.5, fillColor: color.css, fillOpacity: 0.9 });
  m.bindPopup(popupFor(d, controller, color.css), { maxWidth: 300 });
  return m;
}

function popupFor(d: DetectionRecord, controller: AppController, colorCss: string): HTMLElement {
  const color = { css: colorCss };
  const sp = controller.speciesByScientific(d.scientific);
  const popup = el(
    'div',
    null,
    el('div', { class: 'chip', style: 'margin-bottom:6px' }, el('span', { class: 'swatch', style: `background:${color.css}` }), el('span', { class: 'chip-names' }, el('span', { class: 'chip-common' }, sp?.common ?? d.common), el('span', { class: 'chip-sci' }, d.scientific))),
    el('div', { class: 'small' }, `${fmtDateTime(d.time)} · ${pct(d.confidence)}`),
    locationBlock(d.lat!, d.lon!, { accuracy: d.accuracy, compact: true }),
    el('div', null, el('a', { href: speciesHref(d.scientific) }, 'Open species page')),
  );
  return popup;
}

/** Small map for a single species' detections (species detail page). Returns a dispose function. */
export function createMiniMap(container: HTMLElement, dets: DetectionRecord[], controller: AppController): () => void {
  const map = baseMap(container);
  const cluster = L.markerClusterGroup({ maxClusterRadius: 40 });
  for (const d of dets) cluster.addLayer(markerFor(d, controller));
  map.addLayer(cluster);
  const bounds = cluster.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 14 });
  return () => map.remove();
}

export type HistoryMapMode = 'pins' | 'heat';

/**
 * Map for one species' sighting history: clustered pins or a heat layer
 * (leaflet.heat, BSD-2-Clause) over the same OSM tiles. Returns controls.
 */
export function createHistoryMap(container: HTMLElement, dets: DetectionRecord[], controller: AppController, mode: HistoryMapMode): { setMode(mode: HistoryMapMode): void; dispose(): void } {
  const map = baseMap(container);
  const pins = L.markerClusterGroup({ maxClusterRadius: 40 });
  for (const d of dets) pins.addLayer(markerFor(d, controller));
  // Weight each point by confidence so sure identifications glow brighter.
  const heat = L.heatLayer(
    dets.map((d) => [d.lat!, d.lon!, Math.max(0.2, d.confidence)] as L.HeatLatLngTuple),
    { radius: 28, blur: 20, maxZoom: 17, minOpacity: 0.3 },
  );
  let current: L.Layer | null = null;
  const setMode = (m: HistoryMapMode) => {
    const next = m === 'heat' ? heat : pins;
    if (current === next) return;
    if (current) map.removeLayer(current);
    map.addLayer(next);
    current = next;
  };
  setMode(mode);
  const bounds = pins.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
  return { setMode, dispose: () => map.remove() };
}

export function mapView(ctx: ViewContext): View {
  const { controller } = ctx;
  const container = el('div', { class: 'map', 'data-testid': 'map' });
  const speciesSel = el('select', { 'aria-label': 'Filter by species' }, el('option', { value: '' }, 'All species'));
  const fromInput = el('input', { type: 'date', 'aria-label': 'From date' });
  const toInput = el('input', { type: 'date', 'aria-label': 'To date' });
  const summary = el('div', { class: 'small muted' }, 'Loading detections…');
  const root = el(
    'div',
    null,
    el('section', { class: 'card' }, el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:2' }, el('label', null, 'Species'), speciesSel), el('div', { class: 'field', style: 'flex:1' }, el('label', null, 'From'), fromInput), el('div', { class: 'field', style: 'flex:1' }, el('label', null, 'To'), toInput)), summary),
    container,
    el('p', { class: 'small muted' }, 'Markers use each species’ colour; tap one for details. Tiles come from OpenStreetMap and are not cached for offline use.'),
  );

  let map: L.Map | null = null;
  let cluster: L.MarkerClusterGroup | null = null;
  let all: DetectionRecord[] = [];
  let firstFit = true;

  const apply = () => {
    if (!map || !cluster) return;
    const from = fromInput.value ? new Date(fromInput.value).getTime() : -Infinity;
    const to = toInput.value ? new Date(toInput.value).getTime() + 86_400_000 : Infinity;
    const filtered = all.filter((d) => d.lat != null && d.lon != null && (!speciesSel.value || d.scientific === speciesSel.value) && d.time >= from && d.time < to);
    cluster.clearLayers();
    for (const d of filtered) cluster.addLayer(markerFor(d, controller));
    summary.textContent = `${filtered.length} of ${all.filter((d) => d.lat != null).length} located detections shown (${all.length} total).`;
    const bounds = cluster.getBounds();
    if (firstFit && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
      firstFit = false;
    }
  };

  const load = async () => {
    all = await listDetections().catch(() => []);
    const names = new Map<string, string>();
    for (const d of all) names.set(d.scientific, d.common);
    const current = speciesSel.value;
    speciesSel.replaceChildren(el('option', { value: '' }, 'All species'));
    for (const [sci, common] of Array.from(names.entries()).sort((a, b) => a[1].localeCompare(b[1]))) speciesSel.appendChild(el('option', { value: sci, selected: sci === current }, `${common} (${sci})`));
    apply();
  };

  speciesSel.addEventListener('change', apply);
  fromInput.addEventListener('change', apply);
  toInput.addEventListener('change', apply);
  const unsub = controller.on('detections-changed', () => void load());

  // Leaflet needs the container in the DOM with a size.
  requestAnimationFrame(() => {
    map = baseMap(container);
    const loc = controller.location.get().location;
    map.setView(loc ? [loc.lat, loc.lon] : [20, 0], loc ? 11 : 2);
    cluster = L.markerClusterGroup({ maxClusterRadius: 50 });
    map.addLayer(cluster);
    void load();
  });

  return {
    el: root,
    dispose() {
      unsub();
      map?.remove();
    },
  };
}
