import { SOUND_ONLY_NOTE } from '../../species/sound-only';
import type { Species } from '../../model/labels';
import { getClip, listSightingsForSpecies } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import type { View, ViewContext } from '../app';
import { clipPlayer } from '../components/clip-player';
import { locationBlock } from '../components/location-block';
import { memberGate } from '../components/member-gate';
import { speciesChip } from '../components/species-chip';
import { el, fmtDateTime, pct } from '../dom';
import { hrefFor } from '../router';
import { createHistoryMap, describeSighting, type HistoryMapMode } from './map';

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
  const mapCard = el('section', { class: 'card' }, el('div', { class: 'row between' }, el('h3', { style: 'margin:0' }, 'Where you heard it'), modeBtn), mapBox, el('p', { class: 'small muted' }, 'Your own sightings, from this phone. The map needs a connection.'));
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
    let sightings: SightingRecord[];
    try {
      sightings = await listSightingsForSpecies(sp.scientific);
    } catch {
      summary.textContent = 'Could not read sightings.';
      return;
    }
    const located = sightings.filter((s) => s.lat != null && s.lon != null);
    const windows = sightings.reduce((n, s) => n + s.hits, 0);
    summary.textContent = sightings.length
      ? `${sightings.length} sighting${sightings.length === 1 ? '' : 's'} (${windows} analysed window${windows === 1 ? '' : 's'}), ${located.length} with a position · first ${fmtDateTime(sightings[0].firstTime)} · last ${fmtDateTime(sightings[sightings.length - 1].lastTime)}`
      : 'No sightings of this species yet.';

    const clip = await getClip(sp.scientific).catch(() => undefined);
    clipBox.replaceChildren();
    if (clip) {
      const player = clipPlayer(clip);
      disposers.push(player.dispose);
      clipBox.appendChild(player.el);
    }

    list.replaceChildren();
    for (const s of sightings.slice().reverse()) {
      const where = s.lat != null && s.lon != null ? locationBlock(s.lat, s.lon, { accuracy: s.accuracy, fixTime: s.fixTime ?? null, time: s.firstTime, compact: true }) : el('div', { class: 'small muted' }, 'No position recorded');
      const link = s.recordingId ? el('a', { class: 'small', href: hrefFor({ name: 'recording', id: s.recordingId }) }, 'Open recording') : null;
      list.appendChild(el('div', { class: 'list-item' }, el('div', { class: 'row between' }, el('div', { class: 'title' }, fmtDateTime(s.firstTime)), el('div', null, `${pct(s.peakConfidence)} · ${s.source}`)), el('div', { class: 'small muted' }, describeSighting(s)), s.soundOnly ? el('div', { class: 'sound-only-note', 'data-testid': 'sound-only-note' }, SOUND_ONLY_NOTE) : null, where, link));
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
