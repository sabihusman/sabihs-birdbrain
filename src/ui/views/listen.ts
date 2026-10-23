import { BROWSER_UNSUPPORTED_HINT, BROWSER_UNSUPPORTED_TITLE } from '../../app/browser-support';
import type { WindowResult } from '../../app/controller';
import type { ListenLayout } from '../../app/settings';
import { WINDOW_SECONDS } from '../../model/constants';
import type { Species } from '../../model/labels';
import { selectDetections } from '../../model/postprocess';
import { speciesColor } from '../../species/colors';
import { groupRecent, LUMP_GAP_SECONDS, toggleExpanded, type KeyedHit } from '../../species/recent';
import { plusCode } from '../../geo/pluscode';
import type { View, ViewContext } from '../app';
import { recentGroupCard } from '../components/recent-group-card';
import { resultCard } from '../components/result-card';
import { birdnetCredit } from '../components/source-credit';
import { speciesChip } from '../components/species-chip';
import { MODEL_SIZE_MB, welcomeCard } from '../components/welcome';
import { el, fmtDuration, pct } from '../dom';
import { hrefFor } from '../router';
import { describeModelProgress } from '../model-progress';
import { listenStatus, type ListenStatus } from '../status';
import { micHelp } from '../mic-help';
import { PipelineView } from '../viz/pipeline';
import { SpectrogramView } from '../viz/spectrogram';
import { TimelineView, type TimelinePoint } from '../viz/timeline';
import { WaveformView } from '../viz/waveform';

/** "How BirdNET decides" stays open for the session once opened (DESIGN_GUIDE.md §5, §6). */
let howItWorksOpen = false;
/** Candidates at or above this but below the threshold count as "more sounds below your minimum". */
const LOW_FLOOR = 0.1;

export const STATE_TEXT: Record<ListenStatus, { title: string; hint: string }> = {
  idle: { title: 'Model not loaded', hint: `The bird model downloads once, the first time you start. About ${MODEL_SIZE_MB} MB; use Wi-Fi if you can.` },
  loading: { title: 'Loading the model', hint: `One-time download, about ${MODEL_SIZE_MB} MB. Use Wi-Fi if you can.` },
  ready: { title: 'Ready', hint: 'Point the bottom of your phone toward the sound.' },
  listening: { title: 'Listening', hint: 'Results appear below as birds are heard.' },
  paused: { title: 'Paused', hint: 'Listening paused while the app was in the background. Tap to resume.' },
  'mic-blocked': { title: 'Mic blocked', hint: 'The browser is not allowing the microphone.' },
  error: { title: 'Something went wrong', hint: 'Try again.' },
  offline: { title: 'Offline', hint: 'Listening works; AI questions and the map are unavailable.' },
  unsupported: { title: BROWSER_UNSUPPORTED_TITLE, hint: BROWSER_UNSUPPORTED_HINT },
};

/** Hits kept for the Listen screen (this view's session). Grouping and lumping happen at render time (src/species/recent.ts). */
const MAX_RECENT_HITS = 400;

export function listenView(ctx: ViewContext): View {
  const { controller } = ctx;
  const settings = controller.settings;
  const subs: Array<() => void> = [];
  const disposers: Array<() => void> = [];
  let layout: ListenLayout = settings.get().listenLayout;

  // ---- shared pieces -------------------------------------------------------
  const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const startBtn = el('button', { class: 'mic-button', type: 'button', 'data-testid': 'start-stop', 'aria-label': 'Start listening' });
  startBtn.innerHTML = `${MIC}<span>Start listening</span>`;
  const stopBtn = el('button', { class: 'btn big stop', type: 'button', 'data-testid': 'stop' }, 'Stop listening');
  const dockStartBtn = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'dock-start' }, 'Start listening');
  const dockStopBtn = el('button', { class: 'btn', type: 'button', 'data-testid': 'dock-stop' }, 'Stop');
  const recordBtn = el('button', { class: 'btn small', type: 'button', 'data-testid': 'record' }, '● Record');
  const demoBtn = el('button', { class: 'btn small', type: 'button', 'data-testid': 'demo' }, 'Try the sample clip');
  const tryAgainBtn = el('button', { class: 'btn', type: 'button', 'data-testid': 'try-again' }, 'Try again');
  const resumeBtn = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'resume' }, 'Resume listening');

  /** Focus shows one line about the previous bird instead of any list. */
  const lastBirdLine = el('p', { class: 'small muted last-bird', 'data-testid': 'last-bird', hidden: true }, '');
  const stateIcon = el('span', { class: 'state-icon', 'aria-hidden': 'true' }, '');
  const stateTitle = el('h2', { class: 'state-title' }, '');
  const stateHint = el('p', { class: 'muted state-hint' }, '');
  const status = el('div', { class: 'small muted', 'data-testid': 'listen-status', role: 'status', 'aria-live': 'polite' }, '');
  // Download progress on the panel itself, not only in the header pill (DECISIONS.md #70).
  const modelBar = el('div', { class: 'progress', 'data-testid': 'model-progress', role: 'progressbar', 'aria-label': 'Model download', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, el('span', { style: 'width:0%' }));
  const modelText = el('div', { class: 'small muted', 'data-testid': 'model-text' }, '');
  const renderModelProgress = (s: ReturnType<typeof controller.inference.getStatus>) => {
    const p = describeModelProgress(s, controller.modelFromCache);
    modelText.textContent = p.text;
    const percent = Math.round(p.fraction * 100);
    (modelBar.firstElementChild as HTMLElement).style.width = `${percent}%`;
    modelBar.setAttribute('aria-valuenow', String(percent));
    modelBar.setAttribute('aria-valuetext', p.text || `${percent}%`);
  };
  // Steps for the browser in use (Chrome, Firefox and Edge on iPhone keep the switch under Settings › Apps).
  const help = micHelp(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const micSteps = el(
    'div',
    { class: 'stack mic-steps', 'data-testid': 'mic-steps', 'data-browser': help.browser },
    el('p', null, 'Birdbrain needs the microphone to hear birds. Nothing is recorded or uploaded unless you save it.'),
    ...help.steps.map((s) => el('p', null, s)),
    el('p', { class: 'small muted' }, 'You can still ', el('a', { href: '#/recordings' }, 'import a recording'), '.'),
  );

  const timer = el('span', { class: 'panel-timer tabular', 'data-testid': 'timer' }, '0:00');
  const wakeLine = el('span', { class: 'small', 'data-testid': 'wake-line' }, '');
  const level = el('div', { class: 'level', 'aria-hidden': 'true' }, el('span'));
  const conditionsTitle = el('strong', { 'data-testid': 'conditions' }, 'Conditions: –');
  const conditionsAdvice = el('span', { class: 'small' }, 'measuring…');
  const conditionsLine = el('div', { class: 'panel-conditions', role: 'status', 'aria-live': 'polite' }, conditionsTitle, el('span', { class: 'small' }, ' · guidance only · '), conditionsAdvice);
  const renderConditions = (a: ReturnType<typeof controller.getConditions>) => {
    conditionsLine.dataset.label = a?.label ?? '';
    conditionsTitle.textContent = `Conditions: ${a ? a.title : '–'}`;
    conditionsAdvice.textContent = a ? a.advice : 'measuring…';
  };
  const panel = el('section', { class: 'listen-panel', 'data-testid': 'listen-panel' }, el('div', { class: 'row between' }, el('span', null, el('span', { class: 'live-dot', 'aria-hidden': 'true' }), ' Listening · ', timer), wakeLine), level, conditionsLine, el('div', { class: 'row' }, stopBtn, recordBtn));

  const chips = el('div', { class: 'chip-row', 'data-testid': 'context-chips' });
  const renderChips = () => {
    const l = controller.location.get();
    const s = settings.get();
    chips.replaceChildren(
      el('span', { class: 'ctx-chip' }, l.location ? `📍 ${plusCode(l.location.lat, l.location.lon)}` : 'No location'),
      el('span', { class: 'ctx-chip' }, l.location && l.week > 0 ? `Week ${l.week} birds` : 'All weeks'),
      el('a', { class: 'ctx-chip', href: '#/settings' }, `Min. ${pct(s.threshold)}`),
    );
    // renderState() owns whether this note is shown: it also depends on the layout.
  };
  const noLocationNote = el('p', { class: 'small muted', 'data-testid': 'no-location-note' }, 'No location: results are not filtered for your area. Settings › Location.');

  // Results
  const resultsList = el('div', { class: 'result-list', 'data-testid': 'results' });
  const lowLine = el('button', { class: 'btn small text', type: 'button', 'data-testid': 'low-toggle', style: 'display:none' }, '');
  const resultsEmpty = el('p', { class: 'muted', 'data-testid': 'results-empty' }, 'Nothing heard above your minimum yet. Birds are easiest to hear at dawn.');
  const recentList = el('div', { class: 'recent-list', 'data-testid': 'recent' });
  const recentEmpty = el('p', { class: 'small muted', 'data-testid': 'recent-empty' }, 'Birds heard this session appear here, one card per species.');
  const recentSummary = el('span', { class: 'small muted recent-summary', 'data-testid': 'recent-summary' });
  const recentNote = el('p', { class: 'small muted' }, `Repeat hits of a bird within ${LUMP_GAP_SECONDS} s count as one. Tap a card for the details. Kept on this device only. `, el('a', { href: '#/map' }, 'Map'));
  /** The cards themselves, moved between the collapsed row and the page by applyLayout(). */
  const recentBody = el('div', { class: 'stack recent-body' }, recentEmpty, recentList, recentNote);
  const recentDetails = el('details', { class: 'fold', 'data-testid': 'recent-fold' }, el('summary', null, el('span', { class: 'fold-title' }, 'Recent sightings'), recentSummary), recentBody);
  /** Bottom dock shows the same cards on the page instead, with a section header. */
  const recentHeader = el('div', { class: 'sect' }, el('span', null, 'Recent sightings'), el('span', { class: 'small muted', 'data-testid': 'recent-inline-summary' }, ''));
  const recentInline = el('section', { class: 'recent-inline', 'data-testid': 'recent-inline' }, recentHeader);

  // Visualisations inside "How it works"
  const waveCanvas = el('canvas', { class: 'waveform', 'aria-label': 'Live waveform' });
  const specCanvas = el('canvas', { style: 'height:180px', 'aria-label': 'Live spectrogram' });
  const specOverlay = el('canvas', { class: 'overlay' });
  const specBox = el('div', { class: 'viz' }, specCanvas, specOverlay);
  const timelineCanvas = el('canvas', { class: 'timeline', 'aria-label': 'Per-species confidence over time' });
  const legend = el('div', { class: 'legend' });
  const waveform = new WaveformView(waveCanvas);
  const waveLabel = el('div', { class: 'viz-label', 'data-testid': 'waveform-label' }, 'Waveform (last 3 s), auto-scaled to the loudest recent sample');
  const spectrogram = new SpectrogramView(specCanvas, specOverlay, 10);
  const timeline = new TimelineView(timelineCanvas, legend, () => controller.species);
  timeline.setThreshold(settings.get().threshold);
  const liveViews = el('div', { class: 'stack' }, waveCanvas, waveLabel, specBox, el('div', { class: 'viz-label' }, 'Spectrogram, our own FFT: an approximation of the two mel spectrograms BirdNET builds internally. Colours follow the loudest recent sound. Dashed box: current 3 s analysis window.'), timelineCanvas, legend, el('div', { class: 'viz-label' }, 'Confidence per species over recent windows (dashed line = your minimum).'));
  // One row on the Listen screen, as in the layout spec: the chips in its summary, the live
  // views and the steps inside. The old separate "How it works" row is gone.
  const pipeline = new PipelineView({ open: howItWorksOpen, onToggle: (open) => (howItWorksOpen = open), lead: liveViews });
  const how = pipeline.el;
  how.addEventListener('toggle', () => {
    if (how.open) howItWorksOpen = true;
    dirty = true;
  });

  // ---- layout ----------------------------------------------------------------
  const stateRow = el('div', { class: 'state-row' }, stateIcon, stateTitle);
  const readyBlock = el('div', { class: 'ready-block', 'data-testid': 'ready-block' }, stateRow, stateHint, modelBar, modelText, micSteps, el('div', { class: 'mic-wrap' }, startBtn), el('div', { class: 'row' }, tryAgainBtn, resumeBtn), chips, noLocationNote, el('div', { class: 'row' }, demoBtn), lastBirdLine, status);
  const resultsBlock = el('section', { class: 'results-block' }, resultsList, lowLine, resultsEmpty);
  const dockTimer = el('span', { class: 'dock-time' }, ' · ', el('span', { class: 'tabular', 'data-testid': 'dock-timer' }, '0:00'));
  const dock = el('div', { class: 'listen-dock', 'data-testid': 'dock' }, el('span', { class: 'dock-text' }, el('span', { class: 'live-dot', 'aria-hidden': 'true' }), ' ', el('span', { 'data-testid': 'dock-state' }, 'Ready'), dockTimer), dockStartBtn, dockStopBtn);
  const focusLatest = el('div', { class: 'focus-latest', 'data-testid': 'focus-latest' });
  const moreBtn = el('button', { class: 'btn', type: 'button', 'data-testid': 'more-birds', 'aria-expanded': 'false' }, '▲ 0 more birds · swipe up or tap');
  // In Focus mode the result list lives in the sheet; elsewhere it stays in the results block (a node has one parent).
  const moreSheet = el('div', { class: 'more-sheet', 'data-testid': 'more-sheet', role: 'dialog', 'aria-label': 'Earlier birds', hidden: true }, el('div', { class: 'row between' }, el('h2', null, 'Earlier birds'), el('button', { class: 'btn small', type: 'button', 'data-testid': 'more-close' }, 'Close')));
  const focusBlock = el('div', { class: 'focus-block' }, focusLatest, moreBtn, moreSheet);
  /** BirdNET is credited where it identifies (DECISIONS.md #66): the last line in flow in every layout. */
  const credit = birdnetCredit();
  const root = el('div', { class: 'listen' });
  // First visit: the welcome layer stands in for the whole Listen screen until the visitor chooses
  // (DECISIONS.md #68). The tabs behind it keep working; nothing downloads on its own.
  const welcome = welcomeCard({
    onStart: () => controller.startIdentifying(),
    onSignIn: () => {
      location.hash = hrefFor({ name: 'settings', section: 'account' });
    },
  });

  /**
   * Put the blocks where this layout wants them (DECISIONS.md #59). Only the arrangement
   * changes: every node is moved, never rebuilt, so the microphone, the audio pipeline and
   * the canvases are untouched. The three layouts differ in the Ready state as well as
   * while listening, which is the whole point of the setting.
   */
  const applyLayout = (next: ListenLayout) => {
    layout = next;
    root.className = `listen${next === 'dock' ? ' listen-dock-layout' : next === 'focus' ? ' listen-focus-layout' : ''}`;
    root.dataset.layout = next;
    if (controller.welcomePending) {
      root.replaceChildren(welcome);
      return;
    }
    // These three nodes live in a different parent per layout; a node has one parent, so
    // detach them first and let each branch place them.
    panel.remove();
    resultsList.remove();
    recentBody.remove();
    if (next === 'focus') {
      focusBlock.prepend(panel);
      moreSheet.appendChild(resultsList);
      recentDetails.appendChild(recentBody);
      root.replaceChildren(readyBlock, focusBlock, credit);
    } else if (next === 'dock') {
      resultsBlock.prepend(resultsList);
      recentInline.appendChild(recentBody);
      // The dock is fixed above the tab bar; the credit is the last line in flow, so it scrolls above the dock, never under it.
      root.replaceChildren(readyBlock, recentInline, resultsBlock, how, credit, dock);
    } else {
      resultsBlock.prepend(resultsList);
      recentDetails.appendChild(recentBody);
      root.replaceChildren(readyBlock, panel, resultsBlock, how, recentDetails, credit);
    }
  };
  applyLayout(layout);

  // ---- state -----------------------------------------------------------------
  let lastResult: WindowResult | null = null;
  const hits: KeyedHit<Species>[] = [];
  const expanded = new Set<string>();
  const recentDisposers: Array<() => void> = [];
  let showLow = false;
  let raf = 0;
  let dirty = true;
  let conditionsText: string | null = null;

  const setHidden = (node: HTMLElement, hidden: boolean) => {
    node.style.display = hidden ? 'none' : '';
  };

  const renderState = () => {
    const st = listenStatus(controller);
    const text = STATE_TEXT[st.status];
    stateIcon.textContent = st.icon;
    stateTitle.textContent = text.title;
    stateHint.textContent = st.hint ?? text.hint;
    readyBlock.dataset.status = st.status;
    root.dataset.status = st.status;
    const listening = st.status === 'listening' || st.status === 'paused';
    // The pipeline chips only animate while the mic is on (DESIGN_GUIDE.md §7).
    pipeline.setListening(st.status === 'listening');
    setHidden(modelBar, st.status !== 'loading');
    setHidden(modelText, st.status !== 'loading');
    setHidden(micSteps, st.status !== 'mic-blocked');
    setHidden(tryAgainBtn, !(st.status === 'mic-blocked' || st.status === 'error'));
    setHidden(resumeBtn, st.status !== 'paused');
    // Ready differs per layout: Consolidated keeps the round mic button, Bottom dock has no
    // mic button at all and fills the screen with cards, Focus shows one giant button.
    const plainReady = st.status === 'ready' || st.status === 'offline';
    // Idle (model not loaded yet, DECISIONS.md #69) shows the same controls as Ready: the first tap loads the model.
    const canStart = st.status === 'ready' || st.status === 'offline' || st.status === 'idle';
    const noModel = st.status === 'unsupported';
    setHidden(startBtn, listening || st.status === 'loading' || st.status === 'mic-blocked' || st.status === 'error' || noModel || layout === 'dock');
    setHidden(chips, listening || layout === 'focus' || (layout === 'dock' && plainReady));
    setHidden(noLocationNote, listening || !!controller.location.get().location || layout === 'focus' || (layout === 'dock' && plainReady));
    setHidden(demoBtn, listening || st.status === 'loading' || noModel || layout === 'focus');
    setHidden(readyBlock, listening);
    if (layout === 'dock') {
      // Cards fill the screen, so the state row only appears when there is something to say
      // (loading, mic blocked, paused, an error). The sample-clip button stays reachable.
      setHidden(stateRow, plainReady);
      setHidden(stateHint, plainReady);
    } else {
      setHidden(stateRow, false);
      setHidden(stateHint, false);
    }
    startBtn.classList.toggle('big', layout === 'focus');
    setHidden(panel, !listening || layout === 'dock');
    setHidden(dock, layout !== 'dock');
    setHidden(focusBlock, layout !== 'focus' || !listening);
    if (layout === 'focus') {
      setHidden(lastBirdLine, listening || lastBirdLine.textContent === '');
      setHidden(readyBlock, listening);
    }
    if (layout === 'dock') {
      setHidden(recentInline, listening);
      setHidden(resultsBlock, !listening);
    }
    if (layout === 'dock') {
      setHidden(dockStartBtn, listening || !canStart);
      setHidden(dockStopBtn, !listening);
      (dock.querySelector('[data-testid="dock-state"]') as HTMLElement).textContent = st.pill;
      setHidden(dockTimer, !listening);
      dock.dataset.status = st.status;
    }
    startBtn.disabled = !canStart;
    demoBtn.disabled = !canStart;
    const rec = controller.getRecordingState();
    recordBtn.textContent = rec.recording ? `■ Stop (${fmtDuration(rec.seconds)})` : '● Record';
    recordBtn.classList.toggle('recording', rec.recording);
  };

  const renderResults = () => {
    for (const d of disposers.splice(0)) d();
    resultsList.replaceChildren();
    const s = settings.get();
    let low = 0;
    if (lastResult) {
      const dets = selectDetections(lastResult.scores, controller.species, { threshold: s.threshold, applyGeo: lastResult.geoApplied, includeNonBird: s.includeNonBird });
      const shown = new Set(dets.map((d) => d.index));
      low = lastResult.scores.filter((x) => x.prob < s.threshold && x.prob >= LOW_FLOOR && x.inRange && (controller.species[x.index]?.isBird || s.includeNonBird)).length;
      // One card per species, newest first; a new hit moves its species to the top (src/species/recent.ts).
      const items = groupRecent(hits);
      const cardFor = (g: (typeof items)[number], large = false) => resultCard(ctx, g.species, { confidence: g.best, time: g.lastHeard, heardTimes: g.detections.length, large, conditions: large ? conditionsText : undefined });
      if (layout !== 'focus') {
        for (const g of items) {
          const card = cardFor(g);
          disposers.push(card.dispose);
          resultsList.appendChild(card.el);
        }
      } else {
        for (const g of items.slice(1)) {
          const card = cardFor(g);
          disposers.push(card.dispose);
          resultsList.appendChild(card.el);
        }
        focusLatest.replaceChildren();
        const latest = items[0];
        if (latest) {
          const card = cardFor(latest, true);
          disposers.push(card.dispose);
          focusLatest.appendChild(card.el);
        } else focusLatest.appendChild(el('p', { class: 'muted' }, 'Listening… the latest bird appears here.'));
        const n = Math.max(0, items.length - 1);
        moreBtn.textContent = `▲ ${n} more bird${n === 1 ? '' : 's'} · swipe up or tap`;
        moreBtn.disabled = n === 0;
      }
      if (showLow) {
        for (const x of lastResult.scores) {
          if (x.prob >= s.threshold || x.prob < LOW_FLOOR || shown.has(x.index)) continue;
          const sp = controller.species[x.index];
          if (sp && (sp.isBird || s.includeNonBird)) resultsList.appendChild(speciesChip(sp, { confidence: x.prob, outOfRange: !x.inRange, subtitle: x.inRange ? 'below your minimum' : 'not expected here (location filter)' }));
        }
      }
    }
    lowLine.textContent = showLow ? 'Hide sounds below your minimum' : `${low} more sound${low === 1 ? '' : 's'} below your minimum · show`;
    setHidden(lowLine, low === 0);
    setHidden(resultsEmpty, hits.length > 0 || showLow);
    timeline.setThreshold(s.threshold);
    dirty = true;
  };

  const renderRecent = () => {
    for (const d of recentDisposers.splice(0)) d();
    recentList.replaceChildren();
    const groups = groupRecent(hits);
    setHidden(recentEmpty, groups.length > 0);
    const detections = groups.reduce((n, g) => n + g.detections.length, 0);
    recentSummary.textContent = groups.length ? `${groups.length} bird${groups.length === 1 ? '' : 's'} · ${detections} detection${detections === 1 ? '' : 's'}` : '';
    (recentHeader.lastElementChild as HTMLElement).textContent = recentSummary.textContent;
    // Focus has no list, so it says what the last bird was instead.
    const newest = groups[0];
    lastBirdLine.textContent = newest ? `Last bird: ${newest.species.common} · ${new Date(newest.lastHeard).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    if (layout === 'focus') setHidden(lastBirdLine, controller.listening || !newest);
    for (const g of groups) {
      const card = recentGroupCard(ctx, g, {
        expanded: expanded.has(g.key),
        onToggle: (key) => {
          toggleExpanded(expanded, key);
          renderRecent();
        },
      });
      recentDisposers.push(card.dispose);
      recentList.appendChild(card.el);
    }
  };

  const onResult = (r: WindowResult) => {
    lastResult = r;
    const point: TimelinePoint = { sec: r.offsetSec, probs: new Map(r.scores.slice(0, 20).map((s) => [s.index, s.prob])) };
    timeline.push(point);
    const colors = r.detections.map((d) => speciesColor(controller.species[d.index]?.scientific ?? ''));
    const names = r.detections.map((d) => controller.species[d.index]?.common ?? '');
    spectrogram.addMark({ startSec: r.offsetSec, endSec: r.offsetSec + WINDOW_SECONDS, colors, labels: names });
    for (const d of r.detections) {
      const sp = controller.species[d.index];
      if (!sp) continue;
      hits.push({ key: sp.scientific, species: sp, time: r.time, confidence: d.prob });
    }
    if (hits.length > MAX_RECENT_HITS) hits.splice(0, hits.length - MAX_RECENT_HITS);
    renderResults();
    renderRecent();
  };

  const loop = () => {
    const now = spectrogram.currentTime;
    if (controller.listening) spectrogram.setLiveWindow(Math.max(0, now - WINDOW_SECONDS), now);
    if (how.open && (dirty || controller.listening)) {
      waveform.draw();
      spectrogram.draw();
      timeline.draw();
      dirty = false;
      const label = `Waveform (last 3 s), auto-scaled to the loudest recent sample: gain ×${waveform.gain}`;
      if (waveLabel.textContent !== label) waveLabel.textContent = label;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // ---- actions ---------------------------------------------------------------
  const start = async () => {
    startBtn.disabled = true;
    dockStartBtn.disabled = true;
    try {
      waveform.reset();
      spectrogram.reset();
      timeline.reset();
      status.textContent = controller.inference.getStatus().state === 'ready' ? 'Starting microphone…' : 'Loading the bird model, then starting the microphone…';
      await controller.startListening();
      renderConditions(null);
      status.textContent = `Listening at ${controller.engine.contextSampleRate ?? '?'} Hz${controller.engine.contextSampleRate !== 48000 ? ' (resampling to 48 kHz)' : ''}`;
      pipeline.setResampling(controller.engine.contextSampleRate !== 48000);
    } catch {
      // The state block (title, hint, steps) and the toast already say why; a third copy on the status line would repeat it.
      status.textContent = '';
    } finally {
      dockStartBtn.disabled = false;
      renderState();
    }
  };
  const stop = async () => {
    await controller.stopListening();
    status.textContent = 'Stopped.';
    renderState();
  };
  startBtn.addEventListener('click', () => void start());
  dockStartBtn.addEventListener('click', () => void start());
  tryAgainBtn.addEventListener('click', () => {
    // After a failed model download there is nothing to start: fetch the model again first.
    if (controller.inference.getStatus().state === 'error') {
      void controller.loadModel().then((ok) => {
        renderState();
        if (ok) void start();
      });
      return;
    }
    void start();
  });
  stopBtn.addEventListener('click', () => void stop());
  dockStopBtn.addEventListener('click', () => void stop());
  resumeBtn.addEventListener('click', () => void controller.resumeListening().then(renderState));
  recordBtn.addEventListener('click', async () => {
    if (controller.getRecordingState().recording) {
      const rec = await controller.stopRecording();
      if (rec) ctx.notify({ kind: 'info', text: `Saved “${rec.name}” (${fmtDuration(rec.durationSec)}). Find it under Recordings.` });
    } else controller.startRecording();
    renderState();
  });
  demoBtn.addEventListener('click', async () => {
    demoBtn.disabled = true;
    status.textContent = controller.inference.getStatus().state === 'ready' ? 'Analysing the bundled BirdNET sample clip…' : 'Loading the bird model, then analysing the sample clip…';
    waveform.reset();
    spectrogram.reset();
    try {
      const r = await controller.analyzeDemoClip(`${controller.baseUrl}samples/birdnet-sample.wav`);
      status.textContent = `Sample analysed in ${Math.round(r.inferMs)} ms. ${r.detections.length ? '' : 'Nothing above your minimum; lower it in Settings to see weaker candidates.'}`;
    } catch (e) {
      status.textContent = `Sample failed: ${(e as Error).message}`;
    } finally {
      renderState();
    }
  });
  lowLine.addEventListener('click', () => {
    showLow = !showLow;
    renderResults();
  });
  const openMore = (open: boolean) => {
    moreSheet.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open) (moreSheet.querySelector('[data-testid="more-close"]') as HTMLElement | null)?.focus();
    else moreBtn.focus();
  };
  moreBtn.addEventListener('click', () => openMore(true));
  (moreSheet.querySelector('[data-testid="more-close"]') as HTMLElement).addEventListener('click', () => openMore(false));
  moreSheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openMore(false);
  });
  // Swipe up on the latest card opens the sheet (touch only; the button covers everyone else).
  let touchY: number | null = null;
  focusBlock.addEventListener('touchstart', (e) => {
    touchY = e.touches[0]?.clientY ?? null;
  });
  focusBlock.addEventListener('touchend', (e) => {
    const y = e.changedTouches[0]?.clientY ?? null;
    if (touchY != null && y != null && touchY - y > 60 && !moreBtn.disabled) openMore(true);
    touchY = null;
  });

  // ---- subscriptions ---------------------------------------------------------
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
    controller.on('conditions', (a) => {
      conditionsText = a ? a.title : null;
      renderConditions(a);
    }),
    controller.on('stage', (s) => pipeline.pulse(s)),
    controller.on('model', (s) => {
      renderModelProgress(s);
      renderState();
    }),
    controller.on('stats', (st) => {
      timer.textContent = fmtDuration(st.elapsedSec);
      (dock.querySelector('[data-testid="dock-timer"]') as HTMLElement).textContent = fmtDuration(st.elapsedSec);
      if (controller.getRecordingState().recording) renderState();
    }),
    controller.on('recording', renderState),
    controller.on('engine', renderState),
    controller.on('welcome', () => {
      // "Start identifying" took the layer down: put the layout back and show the loading state.
      applyLayout(layout);
      renderRecent();
      renderResults();
      renderState();
    }),
    controller.on('wakelock', (w) => {
      wakeLine.textContent = w === 'active' ? 'Screen stays on' : w === 'unsupported' ? 'Keep the screen on yourself: this browser cannot' : w === 'failed' ? 'Could not keep the screen on' : '';
    }),
    controller.on('location', () => {
      renderChips();
      renderState(); // the no-location note depends on the location and on the layout
    }),
    settings.on('change', (s) => {
      // Switching layout rearranges the same nodes; the mic and the analysis keep running.
      if (s.listenLayout !== layout) {
        applyLayout(s.listenLayout);
        renderRecent();
      }
      renderChips();
      renderResults();
      renderState();
    }),
  );
  if (typeof window !== 'undefined') {
    const onlineHandler = () => renderState();
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', onlineHandler);
    subs.push(() => {
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', onlineHandler);
    });
  }

  // Initial state
  {
    renderModelProgress(controller.inference.getStatus());
    renderChips();
    renderConditions(controller.getConditions());
    if (controller.listening) status.textContent = 'Listening…';
    renderState();
    renderResults();
  }

  return {
    el: root,
    dispose() {
      cancelAnimationFrame(raf);
      for (const u of subs) u();
      for (const d of disposers) d();
      for (const d of recentDisposers) d();
      pipeline.dispose();
    },
  };
}
