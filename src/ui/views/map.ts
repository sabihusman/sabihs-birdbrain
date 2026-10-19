import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.heat';
import type { AppController } from '../../app/controller';
import { speciesColor } from '../../species/colors';
import { listSightings } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import type { View, ViewContext } from '../app';
import { el, fmtDateTime, pct } from '../dom';
import { speciesHref } from '../router';
import { locationBlock } from '../components/location-block';
import { cssToken } from '../../theme/theme';

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function baseMap(container: HTMLElement, options: L.MapOptions = {}): L.Map {
  const map = L.map(container, { zoomControl: true, attributionControl: true, ...options });
  // One tile layer, served live from OSM; never cached or prefetched by the service worker.
  L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION, crossOrigin: true }).addTo(map);
  return map;
}

export interface PreviewMap {
  /** Turn on dragging, zooming and the zoom control ("Tap to explore"). */
  enable(): void;
  /** Recolour the dot (the sighting card learns its species after analysis). */
  setColor(css: string): void;
  dispose(): void;
}

/**
 * Small non-interactive map with one dot at a spot (sighting card, species ID
 * card). Every handler is off and there is no zoom control until `enable()`;
 * the OSM attribution stays. Leaflet 1.9 has no `tap` option any more (the
 * tap handler was removed in 1.8), so touch is covered by `dragging` and
 * `touchZoom`.
 */
export function createPreviewMap(container: HTMLElement, lat: number, lon: number, colorCss: string, zoom = 14): PreviewMap {
  const map = baseMap(container, { zoomControl: false, dragging: false, scrollWheelZoom: false, touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false });
  map.setView([lat, lon], zoom);
  const dot = L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 2, fillColor: colorCss, fillOpacity: 0.95, interactive: false }).addTo(map);
  let enabled = false;
  return {
    enable() {
      if (enabled) return;
      enabled = true;
      map.dragging.enable();
      map.scrollWheelZoom.enable();
      map.touchZoom.enable();
      map.doubleClickZoom.enable();
      map.boxZoom.enable();
      map.keyboard.enable();
      L.control.zoom({ position: 'topright' }).addTo(map);
    },
    setColor(css) {
      dot.setStyle({ fillColor: css });
    },
    dispose: () => map.remove(),
  };
}

/** "1 May 2026, 06:30 – 06:30:45 · peak 88 % · 4 windows" */
export function describeSighting(s: SightingRecord): string {
  const when = s.firstTime === s.lastTime ? fmtDateTime(s.firstTime) : `${fmtDateTime(s.firstTime)} – ${new Date(s.lastTime).toLocaleTimeString()}`;
  return `${when} · peak ${pct(s.peakConfidence)} · ${s.hits} window${s.hits === 1 ? '' : 's'}`;
}

function markerFor(s: SightingRecord, controller: AppController): L.CircleMarker {
  const color = speciesColor(s.scientific);
  const m = L.circleMarker([s.lat!, s.lon!], { radius: 8, color: '#fff', weight: 1.5, fillColor: color.css, fillOpacity: 0.9 });
  m.bindPopup(popupFor(s, controller, color.css), { maxWidth: 300 });
  return m;
}

function popupFor(s: SightingRecord, controller: AppController, colorCss: string): HTMLElement {
  const color = { css: colorCss };
  const sp = controller.speciesByScientific(s.scientific);
  const popup = el(
    'div',
    null,
    el('div', { class: 'chip', style: 'margin-bottom:6px' }, el('span', { class: 'swatch', style: `background:${color.css}` }), el('span', { class: 'chip-names' }, el('span', { class: 'chip-common' }, sp?.common ?? s.common), el('span', { class: 'chip-sci' }, s.scientific))),
    el('div', { class: 'small' }, describeSighting(s)),
    locationBlock(s.lat!, s.lon!, { accuracy: s.accuracy, compact: true }),
    el('div', null, el('a', { href: speciesHref(s.scientific) }, 'Open species page')),
  );
  return popup;
}

/** Small map for a single species' sightings (species detail page). Returns a dispose function. */
export function createMiniMap(container: HTMLElement, sightings: SightingRecord[], controller: AppController): () => void {
  const map = baseMap(container);
  const cluster = L.markerClusterGroup({ maxClusterRadius: 40 });
  for (const s of sightings) cluster.addLayer(markerFor(s, controller));
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
export function createHistoryMap(container: HTMLElement, sightings: SightingRecord[], controller: AppController, mode: HistoryMapMode): { setMode(mode: HistoryMapMode): void; dispose(): void } {
  const map = baseMap(container);
  const pins = L.markerClusterGroup({ maxClusterRadius: 40 });
  for (const s of sightings) pins.addLayer(markerFor(s, controller));
  // One point per sighting (not per window), weighted by its peak confidence so sure identifications glow brighter.
  const heat = L.heatLayer(
    sightings.map((s) => [s.lat!, s.lon!, Math.max(0.2, s.peakConfidence)] as L.HeatLatLngTuple),
    // Gradient from the theme's accent through warn to error (status colours from the tokens, not hard-coded).
    { radius: 28, blur: 20, maxZoom: 17, minOpacity: 0.3, gradient: { 0.3: cssToken('accent', '#5FCB97'), 0.65: cssToken('warn', '#E8B36A'), 1: cssToken('error', '#E07A5F') } },
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
  let all: SightingRecord[] = [];
  let firstFit = true;

  const apply = () => {
    if (!map || !cluster) return;
    const from = fromInput.value ? new Date(fromInput.value).getTime() : -Infinity;
    const to = toInput.value ? new Date(toInput.value).getTime() + 86_400_000 : Infinity;
    const filtered = all.filter((s) => s.lat != null && s.lon != null && (!speciesSel.value || s.scientific === speciesSel.value) && s.lastTime >= from && s.firstTime < to);
    cluster.clearLayers();
    for (const s of filtered) cluster.addLayer(markerFor(s, controller));
    summary.textContent = `${filtered.length} of ${all.filter((s) => s.lat != null).length} located sightings shown (${all.length} total).`;
    const bounds = cluster.getBounds();
    if (firstFit && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.2), { maxZoom: 15 });
      firstFit = false;
    }
  };

  const load = async () => {
    all = await listSightings().catch(() => []);
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
