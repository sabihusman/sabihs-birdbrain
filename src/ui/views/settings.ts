import { sightingsToCsv } from '../../export/csv';
import { downloadBlob, timestampForFilename } from '../../export/download';
import { sightingsToGeoJson } from '../../export/geojson';
import { DEFAULT_SETTINGS, type BackendPreference, type LocationMode, type OcclusionResolution } from '../../app/settings';
import { clearAllData, countDetections, countSightings, listSightings } from '../../storage/db';
import { formatBytes, getStorageStatus, PERSIST_EXPLAINED, requestPersistentStorage } from '../../storage/quota';
import type { View, ViewContext } from '../app';
import { el, pct } from '../dom';
import { foldHint } from '../components/rows';
import { accountSection } from './account';
import { whatWeStoreFold } from '../components/what-we-store';
import { layoutPicker } from '../components/layout-picker';
import { describeVoiceProcessing } from '../../audio/mic-constraints';

export function settingsView(ctx: ViewContext): View {
  const { controller } = ctx;
  const settings = controller.settings;
  const s = settings.get();

  // Sliders re-read the store after every change, so a value the store clamped (auto-save never below the detection threshold) shows its real value.
  const syncs: Array<() => void> = [];
  const slider = (label: string, key: 'threshold' | 'overlapSeconds' | 'geoThreshold' | 'autoSaveMinConfidence', min: number, max: number, step: number, fmt: (v: number) => string, hint?: string) => {
    const value = el('span', null, fmt(s[key]));
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(s[key]), 'aria-label': label });
    const sync = () => {
      const v = settings.get()[key];
      input.value = String(v);
      value.textContent = fmt(v);
    };
    syncs.push(sync);
    input.addEventListener('input', () => {
      settings.update({ [key]: Number(input.value) });
    });
    return el('div', { class: 'slider' }, el('div', { class: 'row' }, el('span', null, label), value), input, hint ? el('div', { class: 'small muted' }, hint) : null);
  };
  const unsubSettings = settings.on('change', () => {
    for (const f of syncs) f();
  });

  // Listen layout: preview tiles (DECISIONS.md #45). A tap switches immediately; the store change is mirrored back.
  const picker = layoutPicker(s.listenLayout, (listenLayout) => settings.update({ listenLayout }));
  syncs.push(() => picker.sync(settings.get().listenLayout));

  // A tick box keeps one short line; the rest opens under it, outside the label, so tapping it never flips the box (DECISIONS.md #100).
  const toggle = (label: string, key: 'autoSaveClips' | 'includeNonBird' | 'useWeek' | 'lowCut', line: string, more: string) => {
    const input = el('input', { type: 'checkbox', checked: s[key] });
    input.addEventListener('change', () => settings.update({ [key]: input.checked }));
    return el('div', { class: 'switch-folded' }, el('label', { class: 'switch' }, el('span', null, label), input), foldHint(line, [el('p', null, more)]));
  };

  const select = <T extends string>(label: string, key: 'locationMode' | 'backend' | 'occlusionResolution', options: Array<[T, string]>, hint?: string | Node) => {
    const sel = el('select', { 'aria-label': label });
    for (const [v, text] of options) sel.appendChild(el('option', { value: v, selected: s[key] === v }, text));
    sel.addEventListener('change', () => settings.update({ [key]: sel.value as LocationMode & BackendPreference & OcclusionResolution }));
    return el('div', { class: 'field' }, el('label', null, label), sel, typeof hint === 'string' ? el('div', { class: 'small muted' }, hint) : (hint ?? null));
  };

  // Manual location
  const latInput = el('input', { type: 'number', step: 'any', min: '-90', max: '90', placeholder: 'Latitude', value: s.manualLat ?? '' });
  const lonInput = el('input', { type: 'number', step: 'any', min: '-180', max: '180', placeholder: 'Longitude', value: s.manualLon ?? '' });
  const applyManual = () => settings.update({ manualLat: latInput.value === '' ? null : Number(latInput.value), manualLon: lonInput.value === '' ? null : Number(lonInput.value), manualPlace: null });
  latInput.addEventListener('change', applyManual);
  lonInput.addEventListener('change', applyManual);
  const locationStatus = el('div', { class: 'small muted' }, controller.location.get().message);
  const unsubLoc = controller.location.on('change', (l) => {
    locationStatus.textContent = l.message;
  });

  // Storage
  const storageText = el('div', { class: 'small' }, 'Checking storage…');
  const storageBar = el('div', { class: 'progress' }, el('span', { style: 'width:0%' }));
  // "On" is a fold line; "off" or "not supported" is a warning and stays in view, with the explanation folded under it.
  const persistText = el('div', { class: 'small', 'data-testid': 'persist-status' }, '');
  const persistLine = el('span', null, '');
  const persistMore = el('p', null, '');
  const persistFold = foldHint(persistLine, [persistMore, el('p', { 'data-testid': 'persist-explained' }, PERSIST_EXPLAINED)], { testId: 'persist-fold' });
  const refreshStorage = async () => {
    const st = await getStorageStatus();
    const dets = await countDetections().catch(() => 0);
    const sightings = await countSightings().catch(() => 0);
    if (!st.supported) {
      storageText.textContent = 'Storage size unknown in this browser.';
      return;
    }
    storageText.textContent = `${formatBytes(st.usageBytes)} of ${formatBytes(st.quotaBytes)} used · ${sightings} sightings (${dets} windows)`;
    const frac = st.usageBytes != null && st.quotaBytes ? Math.min(1, st.usageBytes / st.quotaBytes) : 0;
    (storageBar.firstElementChild as HTMLElement).style.width = `${Math.max(1, Math.round(frac * 100))}%`;
    const on = st.persisted === true;
    persistText.textContent = st.persisted === null ? 'Persistent storage: not supported here.' : on ? '' : 'Persistent storage: off. The browser may delete the model and sightings if space runs low.';
    persistText.hidden = on;
    persistLine.textContent = on ? 'Persistent storage: on' : 'Why this matters';
    persistMore.textContent = on ? 'Kept until you delete them.' : '';
    persistMore.hidden = !on;
  };
  const persistBtn = el('button', { class: 'btn small' }, 'Request persistent storage');
  persistBtn.addEventListener('click', async () => {
    const r = await requestPersistentStorage();
    ctx.notify({ kind: 'info', text: r === null ? 'This browser can’t keep storage.' : r ? 'Persistent storage granted.' : 'Persistent storage was not granted.' });
    void refreshStorage();
  });
  void refreshStorage();

  // Export
  const exportCsv = el('button', { class: 'btn small' }, 'Export CSV');
  exportCsv.addEventListener('click', async () => {
    const sightings = await listSightings();
    downloadBlob(new Blob([sightingsToCsv(sightings)], { type: 'text/csv' }), `birdbrain-sightings-${timestampForFilename()}.csv`);
  });
  const exportGeo = el('button', { class: 'btn small' }, 'Export GeoJSON');
  exportGeo.addEventListener('click', async () => {
    const sightings = await listSightings();
    downloadBlob(new Blob([JSON.stringify(sightingsToGeoJson(sightings), null, 1)], { type: 'application/geo+json' }), `birdbrain-sightings-${timestampForFilename()}.geojson`);
  });
  const clearBtn = el('button', { class: 'btn small danger' }, 'Delete all recordings and detections');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete all recordings, detections and saved species pages on this phone? No undo.')) return;
    await clearAllData();
    // A fresh start opens in the default Listen layout again (DECISIONS.md #63).
    controller.settings.update({ listenLayout: DEFAULT_SETTINGS.listenLayout });
    controller.emit('detections-changed', undefined);
    ctx.notify({ kind: 'info', text: 'All data deleted.' });
    void refreshStorage();
  });

  const modelStatus = controller.inference.getStatus();
  const account = accountSection(ctx);

  // Microphone
  const micHeadline = el('div', { 'data-testid': 'voice-processing' }, '');
  const micDetail = el('div', { class: 'small muted' }, '');
  const renderMic = () => {
    const d = describeVoiceProcessing(controller.getMicReport());
    micHeadline.textContent = d.headline;
    micDetail.textContent = d.detail;
  };
  renderMic();
  const unsubMic = controller.on('mic', renderMic);

  const root = el(
    'div',
    null,
    account.el,
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Listen layout'),
      picker.el,
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Detection'),
      slider('Confidence threshold', 'threshold', 0.05, 0.95, 0.05, pct),
      foldHint('Lower: more birds, more mistakes', [el('p', null, 'Lower catches faint or distant birds but adds false IDs.')], { testId: 'threshold-help' }),
      slider('Window overlap', 'overlapSeconds', 0, 2.5, 0.5, (v) => `${v.toFixed(1)} s`),
      toggle('Show non-bird classes', 'includeNonBird', 'Dogs, engines, voices…', 'Dog, engine, siren, human voice and similar.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Microphone'),
      toggle('Low-cut filter (150 Hz)', 'lowCut', 'Cuts wind and handling rumble', 'Cuts wind and handling rumble before the model hears it. Saved audio stays unfiltered.'),
      el('div', { class: 'field' }, micHeadline, foldHint('What this means', [micDetail, el('p', null, 'The app asks the browser to turn off speech processing (echo, noise, gain), which can erase bird sound. Browsers may refuse; this shows the last session.')], { testId: 'mic-fold' })),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Location & season filter'),
      select('Location source', 'locationMode', [
        ['auto', 'Use device location (GPS)'],
        ['manual', 'Enter coordinates manually'],
        ['off', 'No location filter'],
      ]),
      el('div', { class: 'row' }, el('div', { class: 'field', style: 'flex:1' }, el('label', null, 'Latitude'), latInput), el('div', { class: 'field', style: 'flex:1' }, el('label', null, 'Longitude'), lonInput)),
      toggle('Use the current week of the year', 'useWeek', 'Off = all year', 'Off = year-round species list for the location.'),
      slider('Species range threshold', 'geoThreshold', 0.01, 0.2, 0.01, (v) => v.toFixed(2)),
      locationStatus,
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Recording'),
      toggle('Auto-save detections (3 s each)', 'autoSaveClips', 'Keeps 3 s of each detection', 'Saves a detection\u2019s 3 s to Recordings; a bird gets a new clip only when more confident than its last one this session. Separate from members\u2019 10 s ID clips.'),
      slider('Auto-save from', 'autoSaveMinConfidence', 0.05, 0.95, 0.05, pct, 'Never below your confidence threshold.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Analysis'),
      select(
        'Compute backend (applies after reload)',
        'backend',
        [
          ['auto', 'Auto (WebGL, then WASM, then CPU)'],
          ['webgl', 'WebGL (GPU)'],
          ['wasm', 'WebAssembly (CPU)'],
          ['cpu', 'Plain JavaScript (slow)'],
        ],
        `Current: ${modelStatus.backend ?? 'not loaded'}`,
      ),
      select(
        '“Why this ID” resolution',
        'occlusionResolution',
        [
          ['coarse', 'Coarse (6×4 grid, 25 model runs)'],
          ['medium', 'Medium (8×6 grid, 49 runs)'],
          ['fine', 'Fine (12×8 grid, 97 runs)'],
        ],
        foldHint('Finer uses more battery', [el('p', null, 'Finer uses more battery. Phones without graphics acceleration start with Coarse and offer this as a second button.')]),
      ),
    ),
    el('section', { class: 'card' }, el('h2', null, 'Storage'), storageText, storageBar, persistText, persistFold, el('div', { class: 'row' }, persistBtn)),
    el('section', { class: 'card' }, el('h2', null, 'Export'), el('div', { class: 'row' }, exportCsv, exportGeo), foldHint('What’s in the file', [el('p', null, 'One row per sighting: times, species, peak confidence, windows, position, recording.')])),
    el('section', { class: 'card' }, el('h2', null, 'Data'), el('div', { class: 'row' }, clearBtn)),
    el('section', { class: 'card' }, el('h2', null, 'About'), el('p', null, el('a', { href: '#/help' }, 'How it works')), el('p', { class: 'small muted' }, 'Sabih’s Birdbrain · BirdNET V2.4 (CC BY-NC-SA 4.0) · app code MIT · audio never leaves this device.')),
    // Last thing on the page, closed: the full privacy facts are there when wanted and out of the way otherwise.
    whatWeStoreFold(),
  );

  return {
    el: root,
    dispose() {
      unsubSettings();
      unsubLoc();
      unsubMic();
      account.dispose();
    },
  };
}
