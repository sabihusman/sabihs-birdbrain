import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.heat';
import type { AppController } from '../../app/controller';
import { speciesColor } from '../../species/colors';
import { listSightings } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import { KIND_LABEL, groupByPlace, type NaturePlace, type PlaceGrouping } from '../../geo/places';
import { lookupPlaces, placesForPoint, type LookupStatus } from '../../geo/place-lookup';
import type { MapCardsView } from '../../app/settings';
import { birdCardLine, birdsCountLine, placeCardLine, summarizeBirds, type BirdSummary } from '../map-summary';
import { birdPlaceholder, birdThumb } from '../components/bird-thumb';
import { placeIcon } from '../components/place-icon';
import type { View, ViewContext } from '../app';
import { el, fmtDateTime, pct } from '../dom';
import { speciesHref } from '../router';
import { locationBlock } from '../components/location-block';
import { speciesChip } from '../components/species-chip';
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

function markerFor(s: SightingRecord, controller: AppController, look: 'normal' | 'faded' | 'selected' = 'normal', popupMaxHeight?: number): L.CircleMarker {
  const color = speciesColor(s.scientific);
  const style = look === 'faded' ? { opacity: 0.35, fillOpacity: 0.25, className: 'map-marker-faded' } : look === 'selected' ? { radius: 10, weight: 2.5, className: 'map-marker-selected' } : {};
  const m = L.circleMarker([s.lat!, s.lon!], { radius: 8, color: '#fff', weight: 1.5, fillColor: color.css, fillOpacity: 0.9, ...style });
  // On the Map tab the popup scrolls inside the map instead of spilling over its top (popupMaxHeight).
  m.bindPopup(popupFor(s, controller, color.css), { maxWidth: 300, ...(popupMaxHeight ? { maxHeight: popupMaxHeight } : {}) });
  return m;
}

function popupFor(s: SightingRecord, controller: AppController, colorCss: string): HTMLElement {
  const color = { css: colorCss };
  const sp = controller.speciesByScientific(s.scientific);
  const popup = el(
    'div',
    null,
    // Same row as everywhere else (bird photo, colour, names); a plain row only for a species missing from the label list.
    sp
      ? speciesChip(sp, { link: false })
      : el('div', { class: 'chip' }, el('span', { class: 'swatch', style: `background:${color.css}` }), el('span', { class: 'chip-names' }, el('span', { class: 'chip-common' }, s.common), el('span', { class: 'chip-sci' }, s.scientific))),
    el('div', { class: 'small' }, describeSighting(s)),
    locationBlock(s.lat!, s.lon!, { accuracy: s.accuracy, fixTime: s.fixTime ?? null, time: s.firstTime, compact: true }),
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

type Selection = { kind: 'bird'; scientific: string } | { kind: 'place'; key: string } | null;
type PlacesState = { status: 'idle' | 'loading' } | { status: LookupStatus; grouping: PlaceGrouping<SightingRecord> };

/** Key of the "Other spots" card (sightings not near a nature place). */
const OTHER_KEY = 'other';

/**
 * The Map tab: every located sighting on the map, and under it a Birds | Places switch with one
 * card per species or per nature place (DECISIONS.md #72). Tapping a card zooms to its sightings
 * and fades the rest. Places are looked up on OpenStreetMap only when the Places view is open.
 */
export function mapView(ctx: ViewContext): View {
  const { controller } = ctx;
  const settings = controller.settings;
  const container = el('div', { class: 'map map-tab', 'data-testid': 'map' });
  const birdsTab = el('button', { type: 'button', role: 'tab', id: 'map-tab-birds', 'aria-controls': 'map-cards', 'data-testid': 'map-view-birds' }, 'Birds');
  const placesTab = el('button', { type: 'button', role: 'tab', id: 'map-tab-places', 'aria-controls': 'map-cards', 'data-testid': 'map-view-places' }, 'Places');
  const switcher = el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Cards under the map', 'data-testid': 'map-cards-switch' }, birdsTab, placesTab);
  const countLine = el('p', { class: 'map-count small muted', 'aria-live': 'polite', 'data-testid': 'map-count' });
  const statusLine = el('div', { class: 'map-places-status', 'data-testid': 'map-places-status', hidden: true });
  const list = el('div', { class: 'map-cards', id: 'map-cards', role: 'tabpanel', 'data-testid': 'map-cards' });
  const credit = el('p', { class: 'source-credit', hidden: true, 'data-testid': 'places-credit' }, 'Place names: ', el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap'), ' contributors');
  const root = el(
    'div',
    null,
    container,
    switcher,
    countLine,
    statusLine,
    list,
    credit,
    el('p', { class: 'small muted' }, 'Markers use each species’ colour; tap one for details. Tiles come from OpenStreetMap and are not cached for offline use.'),
  );

  let map: L.Map | null = null;
  let cluster: L.MarkerClusterGroup | null = null;
  let focusLayer: L.FeatureGroup | null = null;
  let outline: L.Layer | null = null;
  let located: SightingRecord[] = [];
  let birds: BirdSummary<SightingRecord>[] = [];
  let view: MapCardsView = settings.get().mapCardsView;
  let selection: Selection = null;
  let places: PlacesState = { status: 'idle' };
  let placesToken = 0;
  let disposed = false;

  const placeGroupFor = (key: string): { name: string; sightings: SightingRecord[]; place?: NaturePlace } | null => {
    if (!('grouping' in places)) return null;
    if (key === OTHER_KEY) return { name: 'Other spots', sightings: places.grouping.other };
    const g = places.grouping.groups.find((x) => x.place.id === key);
    return g ? { name: g.place.name, sightings: g.sightings, place: g.place } : null;
  };

  const selectedSightings = (): SightingRecord[] => {
    if (!selection) return [];
    if (selection.kind === 'bird') {
      const sci = selection.scientific;
      return birds.find((b) => b.scientific === sci)?.sightings ?? [];
    }
    return placeGroupFor(selection.key)?.sightings ?? [];
  };

  const fitAll = () => {
    if (!map) return;
    const pts = located.map((s) => [s.lat!, s.lon!] as L.LatLngTuple);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15, animate: false });
  };

  const popupHeight = () => Math.max(140, (map?.getSize().y ?? 300) - 90);
  const marker = (s: SightingRecord, look: 'normal' | 'faded' | 'selected' = 'normal') => markerFor(s, controller, look, popupHeight());

  /** Markers: all in the cluster, or the selection on top at full strength and the rest faded. */
  const drawMarkers = () => {
    if (!map || !cluster || !focusLayer) return;
    cluster.clearLayers();
    focusLayer.clearLayers();
    if (outline) {
      map.removeLayer(outline);
      outline = null;
    }
    map.closePopup();
    const chosen = selectedSightings();
    if (!selection || chosen.length === 0) {
      delete container.dataset.focus;
      for (const s of located) cluster.addLayer(marker(s));
      return;
    }
    container.dataset.focus = selection.kind === 'bird' ? `bird:${selection.scientific}` : `place:${selection.key}`;
    const ids = new Set(chosen.map((s) => s.id));
    for (const s of located) if (!ids.has(s.id)) cluster.addLayer(marker(s, 'faded'));
    const markers = chosen.map((s) => marker(s, 'selected'));
    for (const m of markers) focusLayer.addLayer(m);
    const bounds = L.latLngBounds(chosen.map((s) => [s.lat!, s.lon!] as L.LatLngTuple));
    const accent = cssToken('accent', '#5FCB97');
    if (selection.kind === 'place') {
      const p = placeGroupFor(selection.key)?.place;
      if (p) {
        // The real outline is not downloaded (DECISIONS.md #72): a 500 m dashed circle round a small
        // place's centre, or its dashed bounding box when the place is bigger than that.
        const big = p.bbox && (p.bbox[2] - p.bbox[0] > 0.009 || p.bbox[3] - p.bbox[1] > 0.009 / Math.cos((p.lat * Math.PI) / 180));
        outline = big
          ? L.rectangle([[p.bbox![0], p.bbox![1]], [p.bbox![2], p.bbox![3]]], { color: accent, weight: 2, dashArray: '6 5', fill: false, interactive: false, className: 'place-outline' })
          : L.circle([p.lat, p.lon], { radius: 500, color: accent, weight: 2, dashArray: '6 5', fill: false, interactive: false, className: 'place-outline' });
        outline.addTo(map);
        bounds.extend(big ? L.latLngBounds([p.bbox![0], p.bbox![1]], [p.bbox![2], p.bbox![3]]) : L.latLng(p.lat, p.lon));
      }
    }
    map.fitBounds(bounds.pad(0.3), { maxZoom: 16, animate: false });
    // The newest sighting's details open, as if its marker had been tapped.
    const newest = chosen.reduce((a, b) => (b.lastTime > a.lastTime ? b : a), chosen[0]);
    markers[chosen.indexOf(newest)]?.openPopup();
  };

  const showAllButton = () => {
    const b = el('button', { type: 'button', class: 'link-button', 'data-testid': 'map-show-all' }, 'Show all');
    b.addEventListener('click', () => {
      selection = null;
      drawMarkers();
      fitAll();
      render();
    });
    return b;
  };

  const select = (next: Selection) => {
    selection = next;
    drawMarkers();
    render();
    map?.getContainer().scrollIntoView?.({ block: 'nearest' });
  };

  const birdCard = (b: BirdSummary<SightingRecord>): HTMLElement => {
    const sp = controller.speciesByScientific(b.scientific);
    const selected = selection?.kind === 'bird' && selection.scientific === b.scientific;
    const card = el(
      'button',
      { type: 'button', class: `map-card${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), 'data-testid': 'map-bird-card', 'data-species': b.scientific },
      sp ? birdThumb(sp, 'map-card-thumb') : birdPlaceholder('map-card-thumb'),
      el('span', { class: 'swatch', style: `background:${speciesColor(b.scientific).css}`, 'aria-hidden': 'true' }),
      el('span', { class: 'map-card-names' }, el('span', { class: 'map-card-title' }, b.common), el('span', { class: 'map-card-sub' }, birdCardLine(b.sightings.length, b.last))),
      el('span', { class: 'map-card-chev', 'aria-hidden': 'true' }, '›'),
    );
    card.addEventListener('click', () => {
      // Second tap on the chosen bird: its species page.
      if (selected) location.hash = speciesHref(b.scientific);
      else select({ kind: 'bird', scientific: b.scientific });
    });
    return card;
  };

  const speciesPills = (sciNames: string[]): HTMLElement | null => {
    if (sciNames.length === 0) return null;
    const shown = sciNames.slice(0, 2);
    return el(
      'span',
      { class: 'map-card-pills' },
      ...shown.map((sci) => {
        const common = controller.speciesByScientific(sci)?.common ?? located.find((s) => s.scientific === sci)?.common ?? sci;
        return el('span', { class: 'map-pill' }, el('span', { class: 'swatch', style: `background:${speciesColor(sci).css}`, 'aria-hidden': 'true' }), common);
      }),
      sciNames.length > 2 ? el('span', { class: 'map-pill' }, `+${sciNames.length - 2}`) : null,
    );
  };

  const placeCard = (key: string, title: string, sub: string, kind: Parameters<typeof placeIcon>[0], sciNames: string[]): HTMLElement => {
    const selected = selection?.kind === 'place' && selection.key === key;
    const card = el(
      'button',
      { type: 'button', class: `map-card place${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), 'data-testid': 'map-place-card', 'data-place': key },
      placeIcon(kind),
      el('span', { class: 'map-card-names' }, el('span', { class: 'map-card-title' }, title), el('span', { class: 'map-card-sub' }, sub), speciesPills(sciNames)),
      el('span', { class: 'map-card-chev', 'aria-hidden': 'true' }, '›'),
    );
    card.addEventListener('click', () => select({ kind: 'place', key }));
    return card;
  };

  const setStatus = (text: string | null, retry = false) => {
    statusLine.replaceChildren();
    statusLine.hidden = !text;
    if (!text) return;
    statusLine.append(el('span', null, text));
    if (retry) {
      const b = el('button', { type: 'button', class: 'btn small', 'data-testid': 'map-places-retry' }, 'Retry');
      b.addEventListener('click', () => void loadPlaces());
      statusLine.append(b);
    }
  };

  const showingLine = (name: string) => {
    countLine.replaceChildren(`Showing ${name} · `, showAllButton());
  };

  const renderBirds = () => {
    setStatus(null);
    credit.hidden = true;
    if (located.length === 0) {
      countLine.textContent = 'No sightings with a location yet. Birds you identify with location on show up here.';
      list.replaceChildren();
      return;
    }
    const sel = selection?.kind === 'bird' ? birds.find((b) => b.scientific === (selection as { scientific: string }).scientific) : undefined;
    if (sel) showingLine(sel.common);
    else countLine.textContent = birdsCountLine(birds.length, located.length);
    // The chosen bird moves to the top, so its card stays under the map.
    const ordered = sel ? [sel, ...birds.filter((b) => b !== sel)] : birds;
    list.replaceChildren(...ordered.map(birdCard));
  };

  const renderPlaces = () => {
    credit.hidden = false;
    if (located.length === 0) {
      setStatus(null);
      countLine.textContent = 'No sightings with a location yet. Birds you identify with location on show up here.';
      list.replaceChildren();
      return;
    }
    if (!('grouping' in places)) {
      setStatus(null);
      countLine.textContent = 'Looking up nearby parks and trails…';
      list.replaceChildren();
      return;
    }
    const { grouping, status } = places;
    const known = grouping.groups.length + grouping.other.length > 0;
    if (status === 'offline' && !known) setStatus('Place names need a connection. Your birds are still on the map and under Birds.');
    else if (status === 'offline') setStatus('Offline: showing the place names saved on this phone.');
    else if (status === 'busy') setStatus('Place names are busy, try again later.', true);
    else setStatus(null);
    const sel = selection?.kind === 'place' ? placeGroupFor(selection.key) : null;
    if (sel) showingLine(sel.name);
    else countLine.textContent = `${grouping.groups.length} place${grouping.groups.length === 1 ? '' : 's'} · nature spots only (parks, reserves, gardens, trails)`;
    const cards: HTMLElement[] = grouping.groups.map((g) => placeCard(g.place.id, g.place.name, `${KIND_LABEL[g.place.kind]} · ${placeCardLine(g.sightings.length, g.species.length)}`, g.place.kind, g.species));
    if (grouping.other.length) {
      const species = Array.from(new Set(grouping.other.map((s) => s.scientific)));
      cards.push(el('p', { class: 'map-group-heading' }, 'Not near a nature spot'), placeCard(OTHER_KEY, 'Other spots', placeCardLine(grouping.other.length, species.length), 'other', species));
    }
    if (grouping.unknown.length) cards.push(el('p', { class: 'small muted', 'data-testid': 'map-places-unknown' }, `${grouping.unknown.length} sighting${grouping.unknown.length === 1 ? ' is' : 's are'} waiting for place names.`));
    list.replaceChildren(...cards);
  };

  const render = () => {
    birdsTab.setAttribute('aria-selected', String(view === 'birds'));
    placesTab.setAttribute('aria-selected', String(view === 'places'));
    birdsTab.tabIndex = view === 'birds' ? 0 : -1;
    placesTab.tabIndex = view === 'places' ? 0 : -1;
    list.setAttribute('aria-labelledby', view === 'birds' ? 'map-tab-birds' : 'map-tab-places');
    if (view === 'birds') renderBirds();
    else renderPlaces();
  };

  const regroup = (byCell: Map<string, NaturePlace[]>, status: LookupStatus) => {
    places = { status, grouping: groupByPlace(located, (s) => placesForPoint(byCell, s.lat!, s.lon!)) };
  };

  /** Look places up (cache first). Only ever called while the Places view is showing. */
  const loadPlaces = async () => {
    const token = ++placesToken;
    if (!('grouping' in places)) places = { status: 'loading' };
    render();
    const result = await lookupPlaces(located);
    if (disposed || token !== placesToken) return;
    regroup(result.byCell, result.status);
    if (selection?.kind === 'place' && !placeGroupFor(selection.key)) selection = null;
    if (view === 'places') {
      drawMarkers();
      render();
    }
  };

  const setView = (next: MapCardsView, focus = false) => {
    if (next !== view) {
      view = next;
      settings.update({ mapCardsView: next });
      selection = null;
      drawMarkers();
    }
    render();
    if (focus) (next === 'birds' ? birdsTab : placesTab).focus();
    if (next === 'places' && map) void loadPlaces();
  };
  birdsTab.addEventListener('click', () => setView('birds'));
  placesTab.addEventListener('click', () => setView('places'));
  switcher.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next: MapCardsView = e.key === 'Home' ? 'birds' : e.key === 'End' ? 'places' : view === 'birds' ? 'places' : 'birds';
      setView(next, true);
    }
  });

  let firstFit = true;
  const load = async () => {
    const all = await listSightings().catch(() => [] as SightingRecord[]);
    if (disposed) return;
    located = all.filter((s) => s.lat != null && s.lon != null && Number.isFinite(s.lat) && Number.isFinite(s.lon));
    birds = summarizeBirds(located);
    if (selection?.kind === 'bird' && !birds.some((b) => b.scientific === (selection as { scientific: string }).scientific)) selection = null;
    drawMarkers();
    if (firstFit && located.length) {
      fitAll();
      firstFit = false;
    }
    if (view === 'places') void loadPlaces();
    else render();
  };

  const unsub = controller.on('detections-changed', () => void load());
  render();

  // Leaflet needs the container in the DOM with a size.
  requestAnimationFrame(() => {
    if (disposed) return;
    map = baseMap(container);
    const loc = controller.location.get().location;
    map.setView(loc ? [loc.lat, loc.lon] : [20, 0], loc ? 11 : 2);
    cluster = L.markerClusterGroup({ maxClusterRadius: 50 });
    focusLayer = L.featureGroup();
    map.addLayer(cluster);
    map.addLayer(focusLayer);
    void load();
  });

  return {
    el: root,
    dispose() {
      disposed = true;
      unsub();
      map?.remove();
    },
  };
}
