import { KEEP_SIGHTING, KEPT_SIGHTING, locationBanner, NOT_USUAL_SUBTITLE, notUsualToggleText, SOUND_ONLY_NOTE } from '../../species/sound-only';
import { BROWSER_UNSUPPORTED_HINT, BROWSER_UNSUPPORTED_TITLE } from '../../app/browser-support';
import type { WindowResult } from '../../app/controller';
import type { ListenLayout } from '../../app/settings';
import { WINDOW_SECONDS } from '../../model/constants';
import { selectDetections } from '../../model/postprocess';
import { speciesColor } from '../../species/colors';
import { groupRecent, LUMP_GAP_SECONDS, toggleExpanded } from '../../species/recent';
import { geocoder } from '../../geo/geocode';
import { nearCell, nearName, pickedName, statusLine } from '../../app/status-line';
import type { View, ViewContext } from '../app';
import { recentGroupCard, type RecentGroupCardHandle } from '../components/recent-group-card';
import { resultCard, type ResultCardHandle } from '../components/result-card';
import { keyedPool, syncChildren } from '../keyed';
import { layoutBubble } from '../components/layout-bubble';
import { birdnetCredit } from '../components/source-credit';
import { speciesChip } from '../components/species-chip';
import { MODEL_SIZE_MB, welcomeCard } from '../components/welcome';
import { focusIntroDone, markFocusIntroDone } from '../focus-intro';
import { el, fmtDuration } from '../dom';
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
  idle: { title: 'Model not loaded', hint: `One-time ${MODEL_SIZE_MB} MB download on first start. Wi-Fi best.` },
  loading: { title: 'Loading the model', hint: `One-time ${MODEL_SIZE_MB} MB download.` },
  ready: { title: 'Ready', hint: 'Point the bottom of your phone toward the sound.' },
  listening: { title: 'Listening', hint: 'Results appear below as birds are heard.' },
  paused: { title: 'Paused', hint: 'Paused in the background. Tap to resume.' },
  'mic-blocked': { title: 'Mic blocked', hint: 'The browser is not allowing the microphone.' },
  error: { title: 'Something went wrong', hint: 'Try again.' },
  offline: { title: 'Offline', hint: 'Listening works. No AI questions or map.' },
  unsupported: { title: BROWSER_UNSUPPORTED_TITLE, hint: BROWSER_UNSUPPORTED_HINT },
};


export function listenView(ctx: ViewContext): View {
  const { controller } = ctx;
  const settings = controller.settings;
  const subs: Array<() => void> = [];
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
    el('p', null, 'Needed to hear birds. Audio is kept only if you save it, and never uploaded.'),
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

  // One plain status line before listening, in every layout, instead of the three pills (DECISIONS.md #108).
  const statusText = el('span', null, '');
  const statusLink = el('a', { href: '#/settings', 'data-testid': 'listen-status-link' }, '');
  const statusLineEl = el('p', { class: 'small muted listen-status-line', 'data-testid': 'listen-status-line' }, statusText, ' ', statusLink);
  /** "Near …": the town for the current position (rounded, looked up once and cached) or the place picked by name. */
  let nearPlace: string | null = null;
  let nearKey = '';
  let disposed = false;
  const renderStatusLine = () => {
    const l = controller.location.get();
    const s = settings.get();
    const line = statusLine({ hasLocation: !!l.location, place: nearPlace, useWeek: s.useWeek, threshold: s.threshold, now: new Date() });
    statusText.textContent = line.text;
    statusLink.textContent = line.link ?? '';
    statusLink.hidden = !line.link;
  };
  const resolvePlace = () => {
    const l = controller.location.get();
    const s = settings.get();
    if (!l.location) {
      nearPlace = null;
      nearKey = '';
    } else if (s.locationMode === 'manual' && s.manualPlace) {
      nearPlace = pickedName(s.manualPlace);
      nearKey = '';
    } else {
      const cell = nearCell(l.location.lat, l.location.lon);
      if (cell.key !== nearKey) {
        nearKey = cell.key;
        nearPlace = null;
        // Rounded to ~1 km and cached for 180 days; only while Listen is open (src/geo/geocode.ts).
        void geocoder.lookup(cell, () => !disposed && nearKey === cell.key).then((r) => {
          if (disposed || nearKey !== cell.key || r.status !== 'ok') return;
          nearPlace = nearName(r.label);
          renderStatusLine();
        });
      }
    }
    renderStatusLine();
  };
  /** The status line and the sample clip, in the Ready block (or under the bird in Focus after its first page). */
  const readyExtras = el('div', { class: 'ready-extras' }, statusLineEl, el('div', { class: 'row' }, demoBtn));

  // Results
  const resultsList = el('div', { class: 'result-list', 'data-testid': 'results' });
  const lowLine = el('button', { class: 'btn small text', type: 'button', 'data-testid': 'low-toggle', style: 'display:none' }, '');
  // Birds matched by sound but hidden by the location filter: counted here, one tap away, each with a Keep button (DECISIONS.md #93).
  const notUsualLine = el('button', { class: 'btn small text', type: 'button', 'data-testid': 'not-usual-toggle', style: 'display:none' }, '');
  const notUsualList = el('div', { class: 'not-usual-list', 'data-testid': 'not-usual-list', style: 'display:none' });
  let showNotUsual = false;
  /** Placed per layout: under the results elsewhere, under the earlier birds in Focus. */
  const notUsualBox = el('div', { class: 'stack not-usual' }, notUsualLine, notUsualList);
  // While listening, one line says what the location filter does and carries the held-back count (DECISIONS.md #103);
  // the separate "N birds not usual here · show" line takes over again once listening stops.
  const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
  const bannerIcon = el('span', { class: 'loc-banner-icon' });
  bannerIcon.innerHTML = PIN;
  const bannerText = el('span', null, '');
  const bannerCount = el('button', { class: 'loc-banner-count', type: 'button', 'data-testid': 'location-banner-count' }, '');
  const banner = el('div', { class: 'loc-banner', 'data-testid': 'location-banner', role: 'status' }, el('a', { class: 'loc-banner-text', href: '#/settings' }, bannerIcon, bannerText), bannerCount);
  const renderBanner = () => {
    const l = controller.location.get();
    const held = controller.getNotUsual().filter((b) => !b.kept).length;
    const b = locationBanner(!!l.location, l.status, held, showNotUsual);
    banner.dataset.kind = b.kind;
    bannerText.textContent = b.text;
    bannerCount.textContent = b.count ?? '';
    bannerCount.hidden = !b.count;
  };
  bannerCount.addEventListener('click', () => {
    showNotUsual = !showNotUsual;
    renderNotUsual();
    // The list sits with the results, which can be further down than the banner.
    if (showNotUsual) notUsualList.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  });
  const resultsEmpty = el('p', { class: 'muted', 'data-testid': 'results-empty' }, 'Nothing above your minimum yet. Dawn is best.');
  const recentList = el('div', { class: 'recent-list', 'data-testid': 'recent' });
  const recentEmpty = el('p', { class: 'small muted', 'data-testid': 'recent-empty' }, 'Birds you hear appear here, one card each.');
  const recentSummary = el('span', { class: 'small muted recent-summary', 'data-testid': 'recent-summary' });
  const recentNote = el('p', { class: 'small muted' }, `Repeats within ${LUMP_GAP_SECONDS} s count once. Tap a card for details. On this phone only. `, el('a', { href: '#/map' }, 'Map'));
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
  const waveLabel = el('p', { 'data-testid': 'waveform-label' }, 'Waveform, last 3 s (auto-scaled)');
  const spectrogram = new SpectrogramView(specCanvas, specOverlay, 10);
  const timeline = new TimelineView(timelineCanvas, legend, () => controller.species);
  timeline.setThreshold(settings.get().threshold);
  // The four live views stack without their captions, so all of them fit on a phone; the captions open from
  // the ⓘ on the title row (DECISIONS.md #109). The waveform's gain stays on the canvas itself.
  const captions = el(
    'div',
    { class: 'see-captions small muted', id: 'see-captions', hidden: true, 'data-testid': 'see-captions' },
    el('p', null, el('strong', null, 'Steps'), ': where the sound is now, from the mic to the result.'),
    waveLabel,
    el('p', null, el('strong', null, 'Spectrogram'), ': auto-scaled, close to what BirdNET sees. Dashed box: the 3 s being analysed.'),
    el('p', null, el('strong', null, 'Confidence'), ': per bird over time. Dashed line: your minimum.'),
    el('a', { href: '#/help', 'data-testid': 'see-help-link' }, 'How BirdNET decides ›'),
  );
  const infoBtn = el('button', { class: 'see-info', type: 'button', 'aria-label': 'What am I seeing?', 'aria-expanded': 'false', 'aria-controls': 'see-captions', 'data-testid': 'see-info' }, 'ⓘ');
  infoBtn.addEventListener('click', () => {
    captions.hidden = !captions.hidden;
    infoBtn.setAttribute('aria-expanded', String(!captions.hidden));
  });
  const liveViews = el('div', { class: 'stack see-views' }, waveCanvas, specBox, timelineCanvas, legend, captions);
  // One row on the Listen screen, as in the layout spec: the chips in its summary, the live
  // views and the steps inside. The old separate "How it works" row is gone.
  const pipeline = new PipelineView({ open: howItWorksOpen, onToggle: (open) => (howItWorksOpen = open), lead: liveViews, info: infoBtn });
  const how = pipeline.el;
  // The 1–7 steps moved to the help page (DECISIONS.md #109); Listen keeps one quiet link to them.
  const helpLink = el('p', { class: 'small listen-help-link' }, el('a', { href: '#/help', 'data-testid': 'listen-help-link' }, 'How BirdNET decides ›'));
  how.addEventListener('toggle', () => {
    if (how.open) howItWorksOpen = true;
    dirty = true;
  });

  // ---- layout ----------------------------------------------------------------
  const stateRow = el('div', { class: 'state-row' }, stateIcon, stateTitle);
  const readyBlock = el('div', { class: 'ready-block', 'data-testid': 'ready-block' }, stateRow, stateHint, modelBar, modelText, micSteps, el('div', { class: 'mic-wrap' }, startBtn), el('div', { class: 'row' }, tryAgainBtn, resumeBtn), readyExtras, lastBirdLine, status);
  const resultsBlock = el('section', { class: 'results-block' }, resultsList, lowLine, notUsualBox, resultsEmpty);
  const dockTimer = el('span', { class: 'dock-time' }, ' · ', el('span', { class: 'tabular', 'data-testid': 'dock-timer' }, '0:00'));
  const dock = el('div', { class: 'listen-dock', 'data-testid': 'dock' }, el('span', { class: 'dock-text' }, el('span', { class: 'live-dot', 'aria-hidden': 'true' }), ' ', el('span', { 'data-testid': 'dock-state' }, 'Ready'), dockTimer), dockStartBtn, dockStopBtn);
  const focusLatest = el('div', { class: 'focus-latest', 'data-testid': 'focus-latest' });
  // Earlier birds open right under the highlighted one with a tap (DECISIONS.md #83; the swipe-up sheet is gone).
  const moreList = el('div', { class: 'focus-more', id: 'focus-more', 'data-testid': 'focus-more', hidden: true });
  const moreBtn = el('button', { class: 'btn block more-birds', type: 'button', 'data-testid': 'more-birds', 'aria-expanded': 'false', 'aria-controls': 'focus-more' }, '');
  // In Focus mode the result list lives under the button; elsewhere it stays in the results block (a node has one parent).
  const focusBlock = el('div', { class: 'focus-block' }, focusLatest, moreBtn, moreList);
  /** BirdNET is credited where it identifies (DECISIONS.md #66): the last line in flow in every layout. */
  const credit = birdnetCredit();
  const root = el('div', { class: 'listen' });
  // First visit: the welcome layer stands in for the whole Listen screen until the visitor chooses
  // (DECISIONS.md #68). The tabs behind it keep working; nothing downloads on its own.
  const welcome = welcomeCard({
    onStart: () => controller.startIdentifying(),
    onSignIn: () => {
      location.hash = hrefFor({ name: 'signin' });
    },
    onSignUp: () => {
      location.hash = hrefFor({ name: 'signup' });
    },
  });

  /**
   * Put the blocks where this layout wants them (DECISIONS.md #59). Only the arrangement
   * changes: every node is moved, never rebuilt, so the microphone, the audio pipeline and
   * the canvases are untouched. The three layouts differ in the Ready state as well as
   * while listening, which is the whole point of the setting.
   */
  // The layout bubble (DECISIONS.md #101): switch layouts from here, only while not listening.
  const bubble = layoutBubble(layout, (listenLayout) => settings.update({ listenLayout }));
  const applyLayout = (next: ListenLayout) => {
    layout = next;
    bubble.sync(next);
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
    dock.remove();
    notUsualBox.remove();
    banner.remove();
    // Focus may have moved the status line under the bird; every other layout keeps it in the Ready block.
    if (readyExtras.parentElement !== readyBlock) readyBlock.insertBefore(readyExtras, lastBirdLine);
    // Focus moves the conditions note out of the panel; every other layout keeps it above Stop and Record.
    if (conditionsLine.parentElement !== panel) panel.insertBefore(conditionsLine, panel.lastElementChild);
    if (next === 'focus') {
      // The conditions note reads above the bird; the panel with Stop and Record is pinned above the tab bar.
      focusBlock.prepend(conditionsLine);
      focusBlock.prepend(banner);
      moreList.appendChild(resultsList);
      focusBlock.appendChild(notUsualBox);
      recentDetails.appendChild(recentBody);
      root.replaceChildren(readyBlock, focusBlock, helpLink, credit, panel, dock, bubble.el);
    } else if (next === 'dock') {
      resultsBlock.prepend(resultsList);
      resultsBlock.prepend(banner);
      lowLine.after(notUsualBox);
      recentInline.appendChild(recentBody);
      // The dock is fixed above the tab bar; the credit is the last line in flow, so it scrolls above the dock, never under it.
      root.replaceChildren(readyBlock, recentInline, resultsBlock, how, helpLink, credit, dock, bubble.el);
    } else {
      resultsBlock.prepend(resultsList);
      panel.insertBefore(banner, panel.lastElementChild);
      lowLine.after(notUsualBox);
      recentDetails.appendChild(recentBody);
      // The result cards under the panel are the list; the "Recent sightings" dropdown repeated them (#109).
      root.replaceChildren(readyBlock, panel, resultsBlock, how, helpLink, credit, bubble.el);
    }
  };
  applyLayout(layout);

  // ---- state -----------------------------------------------------------------
  // This session's birds live in the controller, so they survive leaving Listen (DECISIONS.md #107).
  let lastResult: WindowResult | null = controller.getLastWindow();
  const expanded = new Set<string>();
  /** Bottom dock opens every card (DECISIONS.md #109); this holds the ones closed by hand. Elsewhere `expanded` holds the open ones. */
  const collapsed = new Set<string>();
  const isOpen = (key: string) => (layout === 'dock' ? !collapsed.has(key) : expanded.has(key));
  // Cards are kept per species and updated in place, so each window doesn't rebuild them (no flicker).
  const resultCards = keyedPool<ResultCardHandle>();
  const recentCards = keyedPool<RecentGroupCardHandle>();
  let showLow = false;
  let raf = 0;
  let dirty = true;
  let conditionsText: string | null = null;

  const setHidden = (node: HTMLElement, hidden: boolean) => {
    node.style.display = hidden ? 'none' : '';
  };

  /** How many earlier birds sit under the highlighted one, and whether that list is open. */
  let earlierCount = 0;
  let earlierOpen = false;
  const renderMoreBtn = () => {
    moreBtn.textContent = earlierOpen ? 'Hide earlier birds' : `Earlier birds (${earlierCount})`;
    moreBtn.setAttribute('aria-expanded', String(earlierOpen));
    setHidden(moreBtn, earlierCount === 0);
    moreList.hidden = !earlierOpen || earlierCount === 0;
  };
  /** The highlighted spot before any bird: what to do next, in plain words. */
  const renderFocusLatestEmpty = (listening: boolean) => {
    if (controller.getSessionHits().length > 0) return;
    const text = listening ? 'Listening… the latest bird appears here.' : 'No birds yet. Tap Start listening below.';
    if (focusLatest.textContent !== text) focusLatest.replaceChildren(el('p', { class: 'muted focus-empty' }, text));
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
    setHidden(banner, !listening);
    renderBanner();
    setHidden(notUsualLine, listening || controller.getNotUsual().every((b) => b.kept));
    // Never next to Stop: the bubble shows before and after listening only.
    setHidden(bubble.el, listening);
    root.classList.toggle('has-layout-bubble', !listening);
    if (listening) bubble.close();
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
    setHidden(readyExtras, listening || noModel);
    setHidden(demoBtn, listening || st.status === 'loading' || noModel);
    setHidden(readyBlock, listening);
    if (layout === 'dock') {
      // Cards fill the screen, so the state row only appears when there is something to say
      // (loading, mic blocked, paused, an error). The sample-clip button stays reachable.
      setHidden(stateRow, plainReady);
      // "Point the bottom of your phone toward the sound." until the first bird (DECISIONS.md #108).
      setHidden(stateHint, plainReady && controller.getSessionHits().length > 0);
    } else {
      setHidden(stateRow, false);
      setHidden(stateHint, false);
    }
    startBtn.classList.toggle('big', layout === 'focus');
    setHidden(panel, !listening || layout === 'dock');
    setHidden(dock, layout !== 'dock');
    setHidden(focusBlock, layout !== 'focus' || !listening);
    if (layout === 'focus') {
      // The big Start page is an introduction, once per session and day (DECISIONS.md #83). After
      // it, the bird stays on screen and the controls sit above the tab bar, listening or not.
      const intro = !listening && !focusIntroDone();
      // The status line and the sample clip sit on the big Start page, or under the bird after it (DECISIONS.md #108).
      const home = intro ? readyBlock : focusBlock;
      if (readyExtras.parentElement !== home) {
        if (intro) readyBlock.insertBefore(readyExtras, lastBirdLine);
        else focusBlock.appendChild(readyExtras);
      }
      root.classList.toggle('focus-intro', intro);
      // States that need words (loading, mic blocked, an error) still show the state block.
      setHidden(readyBlock, listening || (!intro && (canStart || plainReady)));
      setHidden(startBtn, !intro || listening || !canStart);
      setHidden(focusBlock, intro);
      setHidden(lastBirdLine, !intro || lastBirdLine.textContent === '');
      setHidden(dock, intro || listening);
      setHidden(dockStartBtn, listening || !canStart);
      setHidden(dockStopBtn, true);
      setHidden(dockTimer, true);
      (dock.querySelector('[data-testid="dock-state"]') as HTMLElement).textContent = st.status === 'idle' ? 'Ready' : st.pill;
      dock.dataset.status = st.status;
      if (!intro) renderFocusLatestEmpty(listening);
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
    const s = settings.get();
    let low = 0;
    const listNodes: Node[] = [];
    if (lastResult) {
      const dets = selectDetections(lastResult.scores, controller.species, { threshold: s.threshold, applyGeo: lastResult.geoApplied, includeNonBird: s.includeNonBird });
      const shown = new Set(dets.map((d) => d.index));
      low = lastResult.scores.filter((x) => x.prob < s.threshold && x.prob >= LOW_FLOOR && x.inRange && (controller.species[x.index]?.isBird || s.includeNonBird)).length;
      // One card per species, newest first; a new hit moves its species to the top (src/species/recent.ts).
      const items = groupRecent(controller.getSessionHits());
      const cardFor = (g: (typeof items)[number], large = false) => {
        const opts = { confidence: g.best, time: g.lastHeard, heardTimes: g.detections.length, large, conditions: large ? conditionsText : undefined, soundOnly: g.soundOnly };
        const card = resultCards.take(g.key, () => resultCard(ctx, g.species, opts));
        card.update(opts);
        return card.el;
      };
      let latestNode: Node | null = null;
      for (const g of layout === 'focus' ? items.slice(1) : items) listNodes.push(cardFor(g));
      if (layout === 'focus') {
        const latest = items[0];
        if (latest) latestNode = cardFor(latest, true);
        earlierCount = Math.max(0, items.length - 1);
        renderMoreBtn();
      }
      if (showLow) {
        for (const x of lastResult.scores) {
          if (x.prob >= s.threshold || x.prob < LOW_FLOOR || shown.has(x.index)) continue;
          const sp = controller.species[x.index];
          if (sp && (sp.isBird || s.includeNonBird)) listNodes.push(speciesChip(sp, { confidence: x.prob, outOfRange: !x.inRange, subtitle: x.inRange ? 'below your minimum' : 'not expected here (location filter)' }));
        }
      }
      resultCards.sweep();
      if (layout === 'focus') {
        if (latestNode) syncChildren(focusLatest, [latestNode]);
        else renderFocusLatestEmpty(controller.listening);
      }
    } else resultCards.sweep();
    syncChildren(resultsList, listNodes);
    lowLine.textContent = showLow ? 'Hide sounds below your minimum' : `${low} more sound${low === 1 ? '' : 's'} below your minimum · show`;
    setHidden(lowLine, low === 0);
    setHidden(resultsEmpty, controller.getSessionHits().length > 0 || showLow);
    timeline.setThreshold(s.threshold);
    dirty = true;
  };

  const renderNotUsual = () => {
    const birds = controller.getNotUsual().filter((b) => !b.kept);
    notUsualLine.textContent = notUsualToggleText(birds.length, showNotUsual);
    // While listening the banner carries the count; the line is for after Stop.
    setHidden(notUsualLine, birds.length === 0 || controller.listening);
    renderBanner();
    setHidden(notUsualList, !showNotUsual || birds.length === 0);
    if (!showNotUsual) return;
    notUsualList.replaceChildren(
      ...birds.flatMap((b) => {
        const sp = controller.species[b.index];
        if (!sp) return [];
        const keep = el('button', { class: 'btn small', type: 'button', 'data-testid': 'keep-sighting' }, KEEP_SIGHTING);
        keep.addEventListener('click', async () => {
          keep.disabled = true;
          keep.textContent = KEPT_SIGHTING;
          if (!(await controller.keepNotUsual(b.scientific))) {
            keep.disabled = false;
            keep.textContent = KEEP_SIGHTING;
            return;
          }
          ctx.notify({ kind: 'info', text: `${sp.common} kept. ${SOUND_ONLY_NOTE}` });
          renderResults();
          renderRecent();
        });
        return [el('div', { class: 'not-usual-row', 'data-testid': 'not-usual-row', 'data-species': sp.scientific }, speciesChip(sp, { confidence: b.prob, subtitle: NOT_USUAL_SUBTITLE }), keep)];
      }),
    );
  };

  const renderRecent = () => {
    const groups = groupRecent(controller.getSessionHits());
    setHidden(recentEmpty, groups.length > 0);
    const detections = groups.reduce((n, g) => n + g.detections.length, 0);
    recentSummary.textContent = groups.length ? `${groups.length} bird${groups.length === 1 ? '' : 's'} · ${detections} detection${detections === 1 ? '' : 's'}` : '';
    (recentHeader.lastElementChild as HTMLElement).textContent = recentSummary.textContent;
    // Focus has no list, so it says what the last bird was instead.
    const newest = groups[0];
    lastBirdLine.textContent = newest ? `Last bird: ${newest.species.common} · ${new Date(newest.lastHeard).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    if (layout === 'focus') setHidden(lastBirdLine, controller.listening || !newest);
    syncChildren(
      recentList,
      groups.map((g) => {
        const card = recentCards.take(g.key, () =>
          recentGroupCard(ctx, g, {
            expanded: isOpen(g.key),
            onToggle: (key) => {
              toggleExpanded(layout === 'dock' ? collapsed : expanded, key);
              renderRecent();
            },
          }),
        );
        card.update(g, isOpen(g.key));
        return card.el;
      }),
    );
    recentCards.sweep();
  };

  const onResult = (r: WindowResult) => {
    lastResult = r;
    const point: TimelinePoint = { sec: r.offsetSec, probs: new Map(r.scores.slice(0, 20).map((s) => [s.index, s.prob])) };
    timeline.push(point);
    const colors = r.detections.map((d) => speciesColor(controller.species[d.index]?.scientific ?? ''));
    const names = r.detections.map((d) => controller.species[d.index]?.common ?? '');
    spectrogram.addMark({ startSec: r.offsetSec, endSec: r.offsetSec + WINDOW_SECONDS, colors, labels: names });
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
      const label = `Waveform, last 3 s (auto-scaled): gain ×${waveform.gain}`;
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
      status.textContent = controller.inference.getStatus().state === 'ready' ? 'Starting microphone…' : 'Loading the model, then the mic…';
      markFocusIntroDone(); // the Focus introduction has done its job for this session (DECISIONS.md #83)
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
    status.textContent = controller.inference.getStatus().state === 'ready' ? 'Analysing the sample clip…' : 'Loading the model, then the sample…';
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
  notUsualLine.addEventListener('click', () => {
    showNotUsual = !showNotUsual;
    renderNotUsual();
  });
  lowLine.addEventListener('click', () => {
    showLow = !showLow;
    renderResults();
  });
  moreBtn.addEventListener('click', () => {
    earlierOpen = !earlierOpen;
    renderMoreBtn();
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
    controller.on('not-usual', renderNotUsual),
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
      wakeLine.textContent = w === 'active' ? 'Screen stays on' : w === 'unsupported' ? 'Keep the screen on yourself' : w === 'failed' ? 'Could not keep the screen on' : '';
    }),
    controller.on('location', () => {
      resolvePlace();
      renderBanner();
      renderState(); // the no-location note depends on the location and on the layout
    }),
    settings.on('change', (s) => {
      // Switching layout rearranges the same nodes; the mic and the analysis keep running.
      if (s.listenLayout !== layout) {
        applyLayout(s.listenLayout);
        renderRecent();
      }
      resolvePlace();
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

  // Focus pins the panel or the start bar above the tab bar; keep that much room at the end of the page.
  const updateBarSpace = () => {
    root.style.setProperty('--focus-bar-h', `${Math.max(panel.offsetHeight, dock.offsetHeight)}px`);
    // The bubble floats just above the dock or Start bar when one is showing, else just above the tab bar.
    root.style.setProperty('--bubble-lift', `${dock.offsetHeight}px`);
  };
  const barObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateBarSpace);
  barObserver?.observe(panel);
  barObserver?.observe(dock);
  subs.push(() => barObserver?.disconnect());

  // Initial state
  {
    renderMoreBtn();
    renderModelProgress(controller.inference.getStatus());
    resolvePlace();
    renderConditions(controller.getConditions());
    if (controller.listening) status.textContent = 'Listening…';
    renderState();
    renderResults();
    renderRecent();
    renderNotUsual();
  }

  return {
    el: root,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const u of subs) u();
      resultCards.clear();
      recentCards.clear();
      pipeline.dispose();
      bubble.dispose();
    },
  };
}
