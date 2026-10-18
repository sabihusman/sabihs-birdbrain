import type { WindowResult } from '../../app/controller';
import { WINDOW_SECONDS } from '../../model/constants';
import { selectDetections } from '../../model/postprocess';
import { speciesColor } from '../../species/colors';
import type { View, ViewContext } from '../app';
import { speciesChip } from '../components/species-chip';
import { el, fmtDuration, pct } from '../dom';
import { PipelineView } from '../viz/pipeline';
import { SpectrogramView } from '../viz/spectrogram';
import { TimelineView, type TimelinePoint } from '../viz/timeline';
import { WaveformView } from '../viz/waveform';

export function listenView(ctx: ViewContext): View {
  const { controller } = ctx;
  const settings = controller.settings;
  const subs: Array<() => void> = [];

  // Controls ---------------------------------------------------------------
  const startBtn = el('button', { class: 'btn big primary', 'data-testid': 'start-stop' }, 'Start listening');
  const recordBtn = el('button', { class: 'btn', 'data-testid': 'record', disabled: true }, '● Record');
  const demoBtn = el('button', { class: 'btn small', 'data-testid': 'demo' }, 'Try the sample clip');
  const status = el('div', { class: 'muted small', 'data-testid': 'listen-status' }, '');
  const modelBar = el('div', { class: 'progress' }, el('span', { style: 'width:0%' }));
  const modelText = el('div', { class: 'small muted', 'data-testid': 'model-text' }, 'Loading model…');
  const modelBox = el('div', { class: 'stack' }, modelText, modelBar);
  const level = el('div', { class: 'level' }, el('span'));

  const elapsed = el('div', { class: 'value' }, '0:00');
  const windowsStat = el('div', { class: 'value' }, '0');
  const inferStat = el('div', { class: 'value' }, '–');
  const geoStat = el('div', { class: 'value' }, '–');
  const stats = el(
    'div',
    { class: 'stats' },
    el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Elapsed'), elapsed),
    el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Windows'), windowsStat),
    el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Inference'), inferStat),
    el('div', { class: 'stat' }, el('div', { class: 'label' }, 'Species in range'), geoStat),
  );

  const thresholdValue = el('span', null, pct(settings.get().threshold));
  const thresholdInput = el('input', { type: 'range', min: '0.05', max: '0.95', step: '0.05', value: String(settings.get().threshold), 'aria-label': 'Confidence threshold' });
  thresholdInput.addEventListener('input', () => {
    const v = Number(thresholdInput.value);
    thresholdValue.textContent = pct(v);
    settings.update({ threshold: v });
    rerenderResults();
  });
  const threshold = el('div', { class: 'slider' }, el('div', { class: 'row' }, el('span', null, 'Confidence threshold'), thresholdValue), thresholdInput);

  const locationLine = el('div', { class: 'small muted', 'data-testid': 'location-status' }, '');
  const wakeLine = el('div', { class: 'small muted' }, '');

  // Results ----------------------------------------------------------------
  const resultsList = el('div', { class: 'chip-list', 'data-testid': 'results' });
  const resultsEmpty = el('p', { class: 'muted' }, 'Nothing above the threshold yet. Birds are easiest to hear at dawn.');
  const recentList = el('div', { class: 'chip-list', 'data-testid': 'recent' });

  // Visualisation ----------------------------------------------------------
  const waveCanvas = el('canvas', { class: 'waveform', 'aria-label': 'Live waveform' });
  const specCanvas = el('canvas', { style: 'height:180px', 'aria-label': 'Live spectrogram' });
  const specOverlay = el('canvas', { class: 'overlay' });
  const specBox = el('div', { class: 'viz' }, specCanvas, specOverlay);
  const timelineCanvas = el('canvas', { class: 'timeline', 'aria-label': 'Per-species confidence over time' });
  const legend = el('div', { class: 'legend' });
  const waveform = new WaveformView(waveCanvas);
  const spectrogram = new SpectrogramView(specCanvas, specOverlay, 10);
  const timeline = new TimelineView(timelineCanvas, legend, () => controller.species);
  timeline.setThreshold(settings.get().threshold);
  const pipeline = new PipelineView();

  const root = el(
    'div',
    null,
    el('section', { class: 'card' }, el('div', { class: 'row' }, startBtn, recordBtn), level, el('div', { class: 'row between' }, status, demoBtn), modelBox, el('div', { class: 'small muted' }, 'Keep the screen on and the app in front: iOS pauses the microphone in the background.')),
    el('section', { class: 'card' }, el('h2', null, 'Heard now'), resultsList, resultsEmpty, threshold, locationLine, wakeLine, stats),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'What the model sees'),
      waveCanvas,
      el('div', { class: 'viz-label' }, 'Waveform (last 3 s)'),
      specBox,
      el('div', { class: 'viz-label' }, 'Spectrogram, our own FFT. An approximation of the two mel spectrograms BirdNET builds internally. Dashed box: current 3 s analysis window. Colour strips: species detected in each analysed window.'),
      timelineCanvas,
      legend,
      el('div', { class: 'viz-label' }, 'Confidence per species over recent windows (dashed line = your threshold).'),
    ),
    el('section', { class: 'card' }, el('h2', null, 'How it works'), pipeline.el, el('p', { class: 'small muted' }, 'BirdNET marks when each species is present in a 3-second window. It does not separate overlapping calls or count individuals. ', el('a', { href: '#/help' }, 'More about limits'))),
    el('section', { class: 'card' }, el('h2', null, 'Recent detections'), recentList),
  );

  // State ------------------------------------------------------------------
  let lastResult: WindowResult | null = null;
  const timelinePoints: TimelinePoint[] = [];
  const recent: Array<{ time: number; index: number; prob: number }> = [];
  let raf = 0;
  let dirty = true;

  const rerenderResults = () => {
    const s = settings.get();
    resultsList.replaceChildren();
    if (lastResult) {
      const dets = selectDetections(lastResult.scores, controller.species, { threshold: s.threshold, applyGeo: lastResult.geoApplied, includeNonBird: s.includeNonBird });
      for (const d of dets) {
        const sp = controller.species[d.index];
        if (sp) resultsList.appendChild(speciesChip(sp, { confidence: d.prob }));
      }
      // Show the strongest out-of-range candidate greyed out so the filter is visible.
      const hidden = lastResult.scores.find((x) => !x.inRange && x.prob >= s.threshold && controller.species[x.index]?.isBird);
      if (hidden) resultsList.appendChild(speciesChip(controller.species[hidden.index], { confidence: hidden.prob, outOfRange: true, subtitle: 'not expected here (location filter)' }));
    }
    resultsEmpty.style.display = resultsList.childElementCount ? 'none' : '';
    timeline.setThreshold(s.threshold);
    dirty = true;
  };

  const renderRecent = () => {
    recentList.replaceChildren();
    for (const r of recent.slice(-8).reverse()) {
      const sp = controller.species[r.index];
      if (sp) recentList.appendChild(speciesChip(sp, { confidence: r.prob, subtitle: new Date(r.time).toLocaleTimeString() }));
    }
  };

  const onResult = (r: WindowResult) => {
    lastResult = r;
    const point: TimelinePoint = { sec: r.offsetSec, probs: new Map(r.scores.slice(0, 20).map((s) => [s.index, s.prob])) };
    timelinePoints.push(point);
    timeline.push(point);
    const colors = r.detections.map((d) => speciesColor(controller.species[d.index]?.scientific ?? ''));
    const names = r.detections.map((d) => controller.species[d.index]?.common ?? '');
    spectrogram.addMark({ startSec: r.offsetSec, endSec: r.offsetSec + WINDOW_SECONDS, colors, labels: names });
    for (const d of r.detections) recent.push({ time: r.time, index: d.index, prob: d.prob });
    if (recent.length > 50) recent.splice(0, recent.length - 50);
    windowsStat.textContent = String(controller.getStats().windows);
    inferStat.textContent = `${Math.round(r.inferMs)} ms`;
    rerenderResults();
    renderRecent();
  };

  const loop = () => {
    const now = spectrogram.currentTime;
    if (controller.listening) spectrogram.setLiveWindow(Math.max(0, now - WINDOW_SECONDS), now);
    if (dirty || controller.listening) {
      waveform.draw();
      spectrogram.draw();
      timeline.draw();
      dirty = false;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const updateButtons = () => {
    const listening = controller.listening;
    const modelReady = controller.inference.getStatus().state === 'ready';
    startBtn.textContent = listening ? 'Stop listening' : 'Start listening';
    startBtn.classList.toggle('primary', !listening);
    startBtn.disabled = !modelReady && !listening;
    recordBtn.disabled = !listening;
    demoBtn.disabled = !modelReady || listening;
    const rec = controller.getRecordingState();
    recordBtn.textContent = rec.recording ? `■ Stop (${fmtDuration(rec.seconds)})` : '● Record';
    recordBtn.classList.toggle('recording', rec.recording);
  };

  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    try {
      if (controller.listening) {
        await controller.stopListening();
        status.textContent = 'Stopped.';
      } else {
        waveform.reset();
        spectrogram.reset();
        timeline.reset();
        timelinePoints.length = 0;
        status.textContent = 'Starting microphone…';
        await controller.startListening();
        status.textContent = `Listening at ${controller.engine.contextSampleRate ?? '?'} Hz${controller.engine.contextSampleRate !== 48000 ? ' (resampling to 48 kHz)' : ''}`;
        pipeline.setResampling(controller.engine.contextSampleRate !== 48000);
      }
    } catch {
      status.textContent = 'Microphone not available.';
    } finally {
      updateButtons();
    }
  });

  recordBtn.addEventListener('click', async () => {
    if (controller.getRecordingState().recording) {
      const rec = await controller.stopRecording();
      if (rec) ctx.notify({ kind: 'info', text: `Saved “${rec.name}” (${fmtDuration(rec.durationSec)}). Find it under Recordings.` });
    } else controller.startRecording();
    updateButtons();
  });

  demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    status.textContent = 'Analysing the bundled BirdNET sample clip…';
    waveform.reset();
    spectrogram.reset();
    try {
      const r = await controller.analyzeDemoClip(`${controller.baseUrl}samples/birdnet-sample.wav`);
      status.textContent = `Sample analysed in ${Math.round(r.inferMs)} ms. ${r.detections.length ? '' : 'Nothing above the threshold; lower it to see weaker candidates.'}`;
    } catch (e) {
      status.textContent = `Sample failed: ${(e as Error).message}`;
    } finally {
      updateButtons();
    }
  });

  // Subscriptions -----------------------------------------------------------
  subs.push(
    controller.on('chunk', (c) => {
      waveform.push(c);
      spectrogram.push(c);
      dirty = true;
    }),
    controller.on('level', (l) => {
      (level.firstElementChild as HTMLElement).style.width = `${Math.min(100, Math.round(Math.sqrt(l) * 140))}%`;
    }),
    controller.on('window-result', onResult),
    controller.on('stage', (s) => pipeline.pulse(s)),
    controller.on('model', (s) => {
      modelText.textContent = s.state === 'ready' ? `Model ready on ${s.backend} (loaded in ${(s.loadMs / 1000).toFixed(1)} s, warm-up ${(s.warmupMs / 1000).toFixed(1)} s)` : s.message;
      (modelBar.firstElementChild as HTMLElement).style.width = `${Math.round(s.progress * 100)}%`;
      modelBar.style.display = s.state === 'ready' ? 'none' : '';
      updateButtons();
    }),
    controller.on('stats', (st) => {
      elapsed.textContent = fmtDuration(st.elapsedSec);
      windowsStat.textContent = `${st.windows}${st.dropped ? ` (+${st.dropped} skipped)` : ''}`;
    }),
    controller.on('recording', updateButtons),
    controller.on('engine', updateButtons),
    controller.on('wakelock', (w) => {
      wakeLine.textContent = w === 'active' ? 'Screen will stay awake while listening.' : w === 'unsupported' ? 'This browser cannot keep the screen awake. Turn off auto-lock in iOS Settings › Display while listening.' : w === 'failed' ? 'Could not keep the screen awake.' : '';
    }),
    controller.on('location', (l) => {
      locationLine.textContent = `Location filter: ${l.message || l.status}${l.location ? ` · week ${l.week > 0 ? l.week : 'off'}` : ''}`;
    }),
    controller.on('geo-count', (n) => {
      geoStat.textContent = n > 0 ? String(n) : 'all';
    }),
  );

  // Initial state
  {
    const s = controller.inference.getStatus();
    modelText.textContent = s.state === 'ready' ? `Model ready on ${s.backend}` : s.message;
    modelBar.style.display = s.state === 'ready' ? 'none' : '';
    const l = controller.location.get();
    locationLine.textContent = `Location filter: ${l.message || l.status}`;
    const n = controller.getGeoCount();
    geoStat.textContent = n > 0 ? String(n) : 'all';
    if (controller.listening) status.textContent = 'Listening…';
    updateButtons();
    rerenderResults();
  }

  return {
    el: root,
    dispose() {
      cancelAnimationFrame(raf);
      for (const u of subs) u();
    },
  };
}
