import type { Species } from '../../model/labels';
import { getClip, listDetectionsForSpecies } from '../../storage/db';
import type { DetectionRecord } from '../../storage/types';
import type { View, ViewContext } from '../app';
import { clipPlayer } from '../components/clip-player';
import { locationBlock } from '../components/location-block';
import { memberGate } from '../components/member-gate';
import { speciesChip } from '../components/species-chip';
import { el, fmtDateTime, pct } from '../dom';
import { hrefFor } from '../router';
import { createHistoryMap, type HistoryMapMode } from './map';

/** Below this many located sightings the map starts on pins; from here on, heat. */
export const HEAT_DEFAULT_MIN_SIGHTINGS = 10;

export function defaultHistoryMode(locatedCount: number): HistoryMapMode {
  return locatedCount < HEAT_DEFAULT_MIN_SIGHTINGS ? 'pins' : 'heat';
}

/** Member-only sighting history for one species: list plus a heat/pin map of the user's own detections. */
export function speciesHistoryView(ctx: ViewContext, scientific: string): View {
  const { controller, api } = ctx;
  const root = el('div', null);
  const disposers: Array<() => void> = [];

  const build = () => {
    for (const d of disposers.splice(0)) d();
    const sp = controller.speciesByScientific(scientific);
    if (!sp) {
      root.replaceChildren(el('section', { class: 'card' }, controller.species.length ? `Unknown species “${scientific}”.` : 'Loading species list…'));
      return;
    }
    const header = el('section', { class: 'card' }, el('a', { class: 'small', href: hrefFor({ name: 'species-detail', scientific }) }, '‹ Species page'), speciesChip(sp), el('h2', null, 'Sighting history'));
    const gate = memberGate(api, 'Sighting history', () => historyBody(ctx, sp), { testId: 'history-gate' });
    disposers.push(gate.dispose);
    root.replaceChildren(header, gate.el);
  };

  build();
  disposers.push(controller.on('species-loaded', build));
  return {
    el: root,
    dispose() {
      for (const d of disposers) d();
    },
  };
}

function historyBody(ctx: ViewContext, sp: Species): { el: HTMLElement; dispose: () => void } {
  const { controller } = ctx;
  const disposers: Array<() => void> = [];
  const summary = el('div', { class: 'small muted', 'data-testid': 'history-summary' }, 'Loading…');
  const mapBox = el('div', { class: 'map', 'data-testid': 'history-map' });
  const modeBtn = el('button', { class: 'btn small', type: 'button', 'data-testid': 'history-mode' }, '');
  const mapCard = el('section', { class: 'card' }, el('div', { class: 'row between' }, el('h3', { style: 'margin:0' }, 'Where you heard it'), modeBtn), mapBox, el('p', { class: 'small muted' }, 'Heat map and pins show only your own detections, stored on this device. Tiles come from OpenStreetMap and are not cached.'));
  const list = el('div', { class: 'list', 'data-testid': 'history-list' });
  const clipBox = el('div', null);
  const root = el('div', { class: 'stack' }, el('section', { class: 'card' }, summary, clipBox), mapCard, el('section', { class: 'card' }, el('h3', null, 'All sightings'), list));

  let historyMap: ReturnType<typeof createHistoryMap> | null = null;
  let mode: HistoryMapMode = 'pins';
  const setMode = (m: HistoryMapMode) => {
    mode = m;
    modeBtn.textContent = m === 'heat' ? 'Show pins' : 'Show heat map';
    modeBtn.setAttribute('aria-pressed', String(m === 'heat'));
    historyMap?.setMode(m);
  };
  modeBtn.addEventListener('click', () => setMode(mode === 'heat' ? 'pins' : 'heat'));

  const render = async () => {
    let dets: DetectionRecord[];
    try {
      dets = await listDetectionsForSpecies(sp.scientific);
    } catch {
      summary.textContent = 'Could not read detections.';
      return;
    }
    const located = dets.filter((d) => d.lat != null && d.lon != null);
    summary.textContent = dets.length ? `${dets.length} sighting${dets.length === 1 ? '' : 's'}, ${located.length} with a position · first ${fmtDateTime(dets[0].time)} · last ${fmtDateTime(dets[dets.length - 1].time)}` : 'No sightings of this species yet.';

    const clip = await getClip(sp.scientific).catch(() => undefined);
    clipBox.replaceChildren();
    if (clip) {
      const player = clipPlayer(clip);
      disposers.push(player.dispose);
      clipBox.appendChild(player.el);
    }

    list.replaceChildren();
    for (const d of dets.slice().reverse()) {
      const where = d.lat != null && d.lon != null ? locationBlock(d.lat, d.lon, { accuracy: d.accuracy, compact: true }) : el('div', { class: 'small muted' }, 'No position recorded');
      const link = d.recordingId ? el('a', { class: 'small', href: hrefFor({ name: 'recording', id: d.recordingId }) }, 'Open recording') : null;
      list.appendChild(el('div', { class: 'list-item' }, el('div', { class: 'row between' }, el('div', { class: 'title' }, fmtDateTime(d.time)), el('div', null, `${pct(d.confidence)} · ${d.source}`)), where, link));
    }

    mapCard.style.display = located.length ? '' : 'none';
    if (located.length) {
      const start = defaultHistoryMode(located.length);
      requestAnimationFrame(() => {
        if (!mapBox.isConnected) return;
        historyMap?.dispose();
        historyMap = createHistoryMap(mapBox, located, controller, start);
        setMode(start);
      });
    }
  };
  void render();
  disposers.push(controller.on('detections-changed', () => void render()));
  return {
    el: root,
    dispose() {
      historyMap?.dispose();
      for (const d of disposers) d();
    },
  };
}
