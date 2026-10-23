import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.heat';
import type { AppController } from '../../app/controller';
import { speciesColor } from '../../species/colors';
import { listSightings } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import { AREA_RADIUS_M, groupIntoAreas, type Area } from '../../geo/areas';
import { formatNear, geocoder, type PlaceLabel } from '../../geo/geocode';
import type { MapCardsView } from '../../app/settings';
import { birdCardLine, birdsCountLine, placeCardLine, summarizeBirds, type BirdSummary } from '../map-summary';
import { birdPlaceholder, birdThumb, speciesThumbnail } from '../components/bird-thumb';
import { placeIcon } from '../components/place-icon';
import type { View, ViewContext } from '../app';
import { el, fmtDateTime, pct } from '../dom';
import { speciesHref } from '../router';
import { copyText, locationBlock } from '../components/location-block';
import { compactWhen, compactWhere, detailsHref, newestSighting, PIN_NEWEST_PX, pinLabel, pinSize } from '../map-pins';
import { formatLatLon, googleMapsUrl } from '../../geo/pluscode';
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

type DotLook = 'normal' | 'faded' | 'selected';

/** A plain coloured dot for one sighting (no popup bound). */
function dotFor(s: SightingRecord, look: DotLook = 'normal'): L.CircleMarker {
  const color = speciesColor(s.scientific);
  const style = look === 'faded' ? { opacity: 0.35, fillOpacity: 0.25, className: 'map-marker-faded' } : look === 'selected' ? { radius: 10, weight: 2.5, className: 'map-marker-selected' } : {};
  return L.circleMarker([s.lat!, s.lon!], { radius: 8, color: '#fff', weight: 1.5, fillColor: color.css, fillOpacity: 0.9, ...style });
}

/** Species page and history maps: a dot with the full details popup. */
function markerFor(s: SightingRecord, controller: AppController): L.CircleMarker {
  return dotFor(s).bindPopup(popupFor(s, controller, speciesColor(s.scientific).css), { maxWidth: 300 });
}

/** Height of the pointer under a photo pin, in px (drawn by CSS, counted in the icon's anchor). */
const PIN_TIP_PX = 9;

/**
 * Round photo pin for one sighting of the chosen bird (DECISIONS.md #75): the Wikipedia photo (or the
 * bird outline until there is one) in a ring of the species colour, with a pointer at the bottom. The
 * icon is a real element (`L.divIcon({ html: element })`), so the ring colour is set through the CSSOM
 * (`style.setProperty('--ring', …)`), never a style attribute the CSP would block.
 */
function photoPin(s: SightingRecord, controller: AppController, newestId: string | null): L.Marker {
  const size = pinSize(s, newestId);
  const newest = size === PIN_NEWEST_PX;
  const face = el('span', { class: `bird-pin${newest ? ' newest' : ''}` }, birdPlaceholder('bird-pin-photo'));
  face.style.setProperty('--ring', speciesColor(s.scientific).css);
  const sp = controller.speciesByScientific(s.scientific);
  if (sp) {
    void speciesThumbnail(sp).then((src) => {
      if (!src) return;
      const img = el('img', { class: 'bird-pin-photo', src, alt: '', decoding: 'async' }) as HTMLImageElement;
      img.addEventListener('error', () => img.replaceWith(birdPlaceholder('bird-pin-photo')));
      face.replaceChildren(img);
    });
  }
  const height = size + PIN_TIP_PX;
  const icon = L.divIcon({ html: face, className: `bird-pin-icon${newest ? ' newest' : ''}`, iconSize: [size, height], iconAnchor: [size / 2, height], popupAnchor: [0, -height] });
  const m = L.marker([s.lat!, s.lon!], { icon, keyboard: true, riseOnHover: true, zIndexOffset: newest ? 1000 : 0 });
  // The icon element exists only once the marker is on the map; Leaflet already makes it a focusable role="button".
  m.on('add', () => {
    const node = m.getElement();
    if (!node) return;
    node.setAttribute('aria-label', pinLabel(s));
    node.dataset.testid = 'map-bird-pin';
    node.dataset.sighting = s.id;
    if (newest) node.dataset.newest = 'true';
  });
  return m;
}

/** "Copy · Google Maps · Details ›" card for one sighting, about half the old popup (DECISIONS.md #75). */
function compactCard(s: SightingRecord, controller: AppController): HTMLElement {
  const sp = controller.speciesByScientific(s.scientific);
  const photo = el('span', { class: 'compact-photo-ring' }, sp ? birdThumb(sp, 'compact-photo') : birdPlaceholder('compact-photo'));
  photo.style.setProperty('--ring', speciesColor(s.scientific).css);
  const copy = el('button', { type: 'button', class: 'compact-action', 'aria-label': 'Copy coordinates', 'data-testid': 'compact-copy' }, 'Copy');
  copy.addEventListener('click', () => void copyText(formatLatLon(s.lat!, s.lon!), copy));
  return el(
    'div',
    { class: 'compact-card', 'data-testid': 'compact-card', 'data-sighting': s.id },
    el('div', { class: 'compact-head' }, photo, el('div', { class: 'compact-names' }, el('strong', { class: 'compact-name' }, s.common), el('span', { class: 'compact-meta' }, compactWhen(s)))),
    el('div', { class: 'compact-where' }, compactWhere(s)),
    el(
      'div',
      { class: 'compact-actions' },
      copy,
      el('a', { class: 'compact-action', href: googleMapsUrl(s.lat!, s.lon!), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'compact-maps' }, 'Google Maps'),
      el('a', { class: 'compact-action', href: detailsHref(s), 'data-testid': 'compact-details' }, 'Details', el('span', { 'aria-hidden': 'true' }, '\u00a0›')),
    ),
  );
}

/** Small popup that keeps clear of the map's edges: at most 240 px wide, narrower on a narrow map (320 px screens). */
function compactPopupOptions(map: L.Map | null): L.PopupOptions {
  const maxWidth = Math.max(180, Math.min(240, (map?.getSize().x ?? 320) - 64));
  return { className: 'compact-popup', maxWidth, minWidth: Math.min(200, maxWidth), autoPanPadding: [12, 16], closeButton: true };
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
/** Where the area names stand: idle (nothing asked yet), loading, all asked, or stopped by a failure. */
type NamesStatus = 'idle' | 'loading' | 'ok' | 'busy' | 'offline';

/**
 * The Map tab: every located sighting on the map, and under it a Birds | Places switch with one
 * card per species or per 1 km area (DECISIONS.md #72, #73). Tapping a card zooms to its sightings
 * and fades the rest; a chosen bird's sightings show as round photo pins whose tap opens a compact
 * card (#75). Area names come from OpenStreetMap's Nominatim, asked only while the Places
 * view is open.
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
  const credit = el('p', { class: 'source-credit', hidden: true, 'data-testid': 'places-credit' }, 'Place names: © ', el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap'), ' contributors');
  const root = el(
    'div',
    null,
    container,
    switcher,
    countLine,
    statusLine,
    list,
    credit,
    el('p', { class: 'small muted' }, 'Each dot is a sighting in its bird’s colour. Tap a dot or a bird card to show that bird’s photo on the map, then tap the photo for details. Tiles come from OpenStreetMap and are not cached for offline use.'),
  );

  let map: L.Map | null = null;
  let cluster: L.MarkerClusterGroup | null = null;
  let focusLayer: L.FeatureGroup | null = null;
  let outline: L.Layer | null = null;
  let located: SightingRecord[] = [];
  let birds: BirdSummary<SightingRecord>[] = [];
  let view: MapCardsView = settings.get().mapCardsView;
  let selection: Selection = null;
  let areas: Area<SightingRecord>[] = [];
  /** Area key → its name (null: the geocoder knows no name there). Missing: not known yet. */
  const names = new Map<string, PlaceLabel | null>();
  let namesStatus: NamesStatus = 'idle';
  let placesToken = 0;
  let disposed = false;
  /** Photo pins of the chosen bird, by sighting id. */
  const pins = new Map<string, L.Marker>();
  // "Tap the bird for details": a polite status line over the bottom of the map, 4 s per selection.
  const hint = el('p', { class: 'map-hint', role: 'status', 'aria-live': 'polite', 'data-testid': 'map-hint' });
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const setHint = (text: string) => {
    clearTimeout(hintTimer);
    hint.textContent = text;
    hint.classList.toggle('shown', !!text);
    if (text) hintTimer = setTimeout(() => setHint(''), 4000);
  };

  const areaFor = (key: string) => areas.find((a) => a.key === key) ?? null;
  const areaTitle = (a: Area<SightingRecord>) => names.get(a.key)?.name ?? formatNear(a.cell);

  const selectedSightings = (): SightingRecord[] => {
    if (!selection) return [];
    if (selection.kind === 'bird') {
      const sci = selection.scientific;
      return birds.find((b) => b.scientific === sci)?.sightings ?? [];
    }
    return areaFor(selection.key)?.sightings ?? [];
  };

  const fitAll = () => {
    if (!map) return;
    const pts = located.map((s) => [s.lat!, s.lon!] as L.LatLngTuple);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15, animate: false });
  };

  /**
   * A dot on the Map tab. Birds view: a tap chooses that bird and opens the compact card for the
   * tapped sighting (as a card tap would, plus the card). Places view: a tap opens the compact card.
   */
  const marker = (s: SightingRecord, look: DotLook = 'normal') => {
    const m = dotFor(s, look);
    if (view === 'birds') m.on('click', () => selectBird(s.scientific, s.id));
    else m.bindPopup(() => compactCard(s, controller), compactPopupOptions(map));
    return m;
  };

  /**
   * Markers: all in the cluster, or the selection on top and the rest faded. A chosen bird's
   * sightings become photo pins (the newest larger); a chosen area's stay dots. Nothing opens.
   */
  const drawMarkers = () => {
    if (!map || !cluster || !focusLayer) return;
    cluster.clearLayers();
    focusLayer.clearLayers();
    pins.clear();
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
    if (selection.kind === 'bird') {
      const newestId = newestSighting(chosen)?.id ?? null;
      for (const s of chosen) {
        const pin = photoPin(s, controller, newestId).bindPopup(() => compactCard(s, controller), compactPopupOptions(map));
        pins.set(s.id, pin);
        focusLayer.addLayer(pin);
      }
    } else {
      for (const s of chosen) focusLayer.addLayer(marker(s, 'selected'));
    }
    const bounds = L.latLngBounds(chosen.map((s) => [s.lat!, s.lon!] as L.LatLngTuple));
    const accent = cssToken('accent', '#5FCB97');
    if (selection.kind === 'place') {
      const a = areaFor(selection.key);
      if (a) {
        // The area: a dashed 1 km-diameter circle round its centre (DECISIONS.md #73).
        const circle = L.circle([a.lat, a.lon], { radius: AREA_RADIUS_M, color: accent, weight: 2, dashArray: '6 5', fill: false, interactive: false, className: 'place-outline' }).addTo(map);
        outline = circle;
        bounds.extend(circle.getBounds());
      }
    }
    map.fitBounds(bounds.pad(0.3), { maxZoom: 16, animate: false });
  };

  const showAllButton = () => {
    const b = el('button', { type: 'button', class: 'link-button', 'data-testid': 'map-show-all' }, 'Show all');
    b.addEventListener('click', () => {
      selection = null;
      setHint('');
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
    setHint(next?.kind === 'bird' && pins.size ? 'Tap the bird for details' : '');
  };

  /** A dot tapped in the Birds view: that bird is chosen, and the tapped sighting's card opens on its pin. */
  const selectBird = (scientific: string, sightingId: string) => {
    setHint('');
    if (!(selection?.kind === 'bird' && selection.scientific === scientific)) {
      selection = { kind: 'bird', scientific };
      drawMarkers();
      render();
    }
    pins.get(sightingId)?.openPopup();
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

  /** Pin, name (or "Near 41.672, −93.698"), town and state, counts, two species pills and "+K". */
  const placeCard = (a: Area<SightingRecord>): HTMLElement => {
    const key = a.key;
    const selected = selection?.kind === 'place' && selection.key === key;
    const label = names.get(key);
    const pending = label === undefined;
    const second = label?.line2 ? el('span', { class: 'map-card-sub', 'data-testid': 'map-place-where' }, label.line2) : pending && namesStatus === 'loading' ? el('span', { class: 'map-card-sub muted', 'data-testid': 'map-place-looking' }, 'Looking up the name…') : null;
    const card = el(
      'button',
      { type: 'button', class: `map-card place${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), 'data-testid': 'map-place-card', 'data-place': key, 'data-named': String(!!label) },
      placeIcon(),
      el('span', { class: 'map-card-names' }, el('span', { class: 'map-card-title' }, areaTitle(a)), second, el('span', { class: 'map-card-sub' }, placeCardLine(a.sightings.length, a.species.length)), speciesPills(a.species)),
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
      b.addEventListener('click', () => void loadNames());
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
    // Only navigator.onLine === false is "offline"; a failed request while online is "busy".
    const anyNamed = areas.some((a) => names.get(a.key));
    if (namesStatus === 'offline' && !anyNamed) setStatus('Place names need a connection. Your birds are still on the map and under Birds.');
    else if (namesStatus === 'offline') setStatus('Offline: showing the place names saved on this phone.');
    else if (namesStatus === 'busy') setStatus('Place names are busy, try again later.', true);
    else setStatus(null);
    const sel = selection?.kind === 'place' ? areaFor(selection.key) : null;
    if (sel) showingLine(areaTitle(sel));
    else countLine.textContent = `${areas.length} area${areas.length === 1 ? '' : 's'} · each about 1 km across`;
    // Rebuilding the list must not lose the keyboard focus on a card.
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.place;
    list.replaceChildren(...areas.map(placeCard));
    if (focused) list.querySelector<HTMLElement>(`[data-place="${CSS.escape(focused)}"]`)?.focus();
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

  /**
   * Names for the areas: cached ones at once, then one request at a time (the geocoder spaces them
   * 1.1 s apart) for the rest, each card updating as its name arrives. Only ever runs while the
   * Places view is showing, and stops as soon as it closes or a request fails.
   */
  const loadNames = async () => {
    const token = ++placesToken;
    const wanted = () => !disposed && token === placesToken && view === 'places';
    const todo: Area<SightingRecord>[] = [];
    for (const a of areas) {
      const hit = await geocoder.cached(a.cell);
      if (!wanted()) return;
      if (hit) names.set(a.key, hit.label);
      if (!hit?.fresh) todo.push(a);
    }
    namesStatus = todo.length ? 'loading' : 'ok';
    render();
    for (const a of todo) {
      const r = await geocoder.lookup(a.cell, wanted);
      if (!wanted() || r.status === 'cancelled') return;
      if (r.status !== 'ok') {
        namesStatus = r.status;
        render();
        return;
      }
      names.set(a.key, r.label);
      render();
    }
    namesStatus = 'ok';
    render();
  };

  const setView = (next: MapCardsView, focus = false) => {
    if (next !== view) {
      view = next;
      settings.update({ mapCardsView: next });
      selection = null;
      setHint('');
      drawMarkers();
    }
    render();
    if (focus) (next === 'birds' ? birdsTab : placesTab).focus();
    if (next === 'places' && map) void loadNames();
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
    areas = groupIntoAreas(located);
    if (selection?.kind === 'bird' && !birds.some((b) => b.scientific === (selection as { scientific: string }).scientific)) selection = null;
    if (selection?.kind === 'place' && !areaFor(selection.key)) selection = null;
    drawMarkers();
    if (firstFit && located.length) {
      fitAll();
      firstFit = false;
    }
    render();
    if (view === 'places') void loadNames();
  };

  const unsub = controller.on('detections-changed', () => void load());
  render();

  // Leaflet needs the container in the DOM with a size.
  requestAnimationFrame(() => {
    if (disposed) return;
    map = baseMap(container);
    container.append(hint);
    map.on('popupopen', () => setHint(''));
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
      clearTimeout(hintTimer);
      unsub();
      map?.remove();
    },
  };
}
