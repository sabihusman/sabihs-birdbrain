import { detectionsToCsv } from '../../export/csv';
import { downloadBlob, timestampForFilename } from '../../export/download';
import { detectionsToGeoJson } from '../../export/geojson';
import type { BackendPreference, LocationMode, OcclusionResolution } from '../../app/settings';
import { clearAllData, countDetections, listDetections } from '../../storage/db';
import { formatBytes, getStorageStatus, requestPersistentStorage } from '../../storage/quota';
import type { View, ViewContext } from '../app';
import { el, pct } from '../dom';

export function settingsView(ctx: ViewContext): View {
  const { controller } = ctx;
  const settings = controller.settings;
  const s = settings.get();

  const slider = (label: string, key: 'threshold' | 'overlapSeconds' | 'geoThreshold' | 'autoSaveMinConfidence', min: number, max: number, step: number, fmt: (v: number) => string) => {
    const value = el('span', null, fmt(s[key]));
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(s[key]), 'aria-label': label });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      value.textContent = fmt(v);
      settings.update({ [key]: v });
    });
    return el('div', { class: 'slider' }, el('div', { class: 'row' }, el('span', null, label), value), input);
  };

  const toggle = (label: string, key: 'autoSaveClips' | 'includeNonBird' | 'useWeek', hint?: string) => {
    const input = el('input', { type: 'checkbox', checked: s[key] });
    input.addEventListener('change', () => settings.update({ [key]: input.checked }));
    return el('label', { class: 'switch' }, el('span', null, label, hint ? el('div', { class: 'small muted' }, hint) : null), input);
  };

  const select = <T extends string>(label: string, key: 'locationMode' | 'backend' | 'occlusionResolution', options: Array<[T, string]>, hint?: string) => {
    const sel = el('select', { 'aria-label': label });
    for (const [v, text] of options) sel.appendChild(el('option', { value: v, selected: s[key] === v }, text));
    sel.addEventListener('change', () => settings.update({ [key]: sel.value as LocationMode & BackendPreference & OcclusionResolution }));
    return el('div', { class: 'field' }, el('label', null, label), sel, hint ? el('div', { class: 'small muted' }, hint) : null);
  };

  // Manual location
  const latInput = el('input', { type: 'number', step: 'any', min: '-90', max: '90', placeholder: 'Latitude', value: s.manualLat ?? '' });
  const lonInput = el('input', { type: 'number', step: 'any', min: '-180', max: '180', placeholder: 'Longitude', value: s.manualLon ?? '' });
  const applyManual = () => settings.update({ manualLat: latInput.value === '' ? null : Number(latInput.value), manualLon: lonInput.value === '' ? null : Number(lonInput.value) });
  latInput.addEventListener('change', applyManual);
  lonInput.addEventListener('change', applyManual);
  const locationStatus = el('div', { class: 'small muted' }, controller.location.get().message);
  const unsubLoc = controller.location.on('change', (l) => {
    locationStatus.textContent = l.message;
  });

  // Storage
  const storageText = el('div', { class: 'small' }, 'Checking storage…');
  const storageBar = el('div', { class: 'progress' }, el('span', { style: 'width:0%' }));
  const persistText = el('div', { class: 'small muted' }, '');
  const refreshStorage = async () => {
    const st = await getStorageStatus();
    const dets = await countDetections().catch(() => 0);
    if (!st.supported) {
      storageText.textContent = 'Storage estimates are not available in this browser.';
      return;
    }
    storageText.textContent = `${formatBytes(st.usageBytes)} used of ${formatBytes(st.quotaBytes)} available · ${dets} detections stored`;
    const frac = st.usageBytes != null && st.quotaBytes ? Math.min(1, st.usageBytes / st.quotaBytes) : 0;
    (storageBar.firstElementChild as HTMLElement).style.width = `${Math.max(1, Math.round(frac * 100))}%`;
    persistText.textContent = st.persisted === null ? 'Persistent storage: not supported here.' : st.persisted ? 'Persistent storage: granted. iOS may still remove data for sites not used in a while.' : 'Persistent storage: not granted (the browser may evict data under pressure).';
  };
  const persistBtn = el('button', { class: 'btn small' }, 'Request persistent storage');
  persistBtn.addEventListener('click', async () => {
    const r = await requestPersistentStorage();
    ctx.notify({ kind: 'info', text: r === null ? 'navigator.storage.persist() is not available in this browser.' : r ? 'Persistent storage granted.' : 'Persistent storage was not granted.' });
    void refreshStorage();
  });
  void refreshStorage();

  // Export
  const exportCsv = el('button', { class: 'btn small' }, 'Export CSV');
  exportCsv.addEventListener('click', async () => {
    const dets = await listDetections();
    downloadBlob(new Blob([detectionsToCsv(dets)], { type: 'text/csv' }), `birdbrain-detections-${timestampForFilename()}.csv`);
  });
  const exportGeo = el('button', { class: 'btn small' }, 'Export GeoJSON');
  exportGeo.addEventListener('click', async () => {
    const dets = await listDetections();
    downloadBlob(new Blob([JSON.stringify(detectionsToGeoJson(dets), null, 1)], { type: 'application/geo+json' }), `birdbrain-detections-${timestampForFilename()}.geojson`);
  });
  const clearBtn = el('button', { class: 'btn small danger' }, 'Delete all recordings and detections');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete every recording, detection and cached species page on this device? This cannot be undone.')) return;
    await clearAllData();
    controller.emit('detections-changed', undefined);
    ctx.notify({ kind: 'info', text: 'All data deleted.' });
    void refreshStorage();
  });

  const modelStatus = controller.inference.getStatus();

  const root = el(
    'div',
    null,
    el('section', { class: 'card' }, el('h2', null, 'Detection'), slider('Confidence threshold', 'threshold', 0.05, 0.95, 0.05, pct), slider('Window overlap', 'overlapSeconds', 0, 2.5, 0.5, (v) => `${v.toFixed(1)} s`), toggle('Show non-bird classes', 'includeNonBird', 'Dog, engine, siren, human voice and similar.')),
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
      toggle('Use the current week of the year', 'useWeek', 'Off = year-round species list for the location.'),
      slider('Species range threshold', 'geoThreshold', 0.01, 0.2, 0.01, (v) => v.toFixed(2)),
      locationStatus,
    ),
    el('section', { class: 'card' }, el('h2', null, 'Recording'), toggle('Auto-save a clip for each detection', 'autoSaveClips', 'Saves the 3-second window (one per species every 30 s).'), slider('Auto-save when confidence is at least', 'autoSaveMinConfidence', 0.1, 0.95, 0.05, pct)),
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
        'Finer grids take proportionally longer on a phone.',
      ),
    ),
    el('section', { class: 'card' }, el('h2', null, 'Storage'), storageText, storageBar, persistText, el('div', { class: 'row' }, persistBtn)),
    el('section', { class: 'card' }, el('h2', null, 'Export'), el('div', { class: 'row' }, exportCsv, exportGeo), el('p', { class: 'small muted' }, 'All detections with time, species, confidence, position and recording link.')),
    el('section', { class: 'card' }, el('h2', null, 'Data'), el('div', { class: 'row' }, clearBtn)),
    el('section', { class: 'card' }, el('h2', null, 'About'), el('p', null, el('a', { href: '#/help' }, 'How it works, limitations and licences')), el('p', { class: 'small muted' }, 'Sabih’s Birdbrain · BirdNET V2.4 (CC BY-NC-SA 4.0) · app code MIT · audio never leaves this device.')),
  );

  return {
    el: root,
    dispose() {
      unsubLoc();
    },
  };
}
