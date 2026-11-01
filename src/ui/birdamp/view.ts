import type { AppController } from '../../app/controller';
import { groupRecent } from '../../species/recent';
import { listSightedSpecies, listSightings } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import { el } from '../dom';
import { keyedPool, syncChildren } from '../keyed';
import { hrefFor } from '../router';
import type { ListenStatus } from '../status';
import type { SpectrogramView } from '../viz/spectrogram';
import type { WaveformView } from '../viz/waveform';
import { lcdClock, levelPercent } from './lcd';
import { emptyText, filterRows, heardRows, LIBRARY_TABS, marqueeBird, nearRows, sightingRows, startOfDay, totalText, type LibraryRow, type LibraryTab } from './library';
import { hiddenWindows, loadWindows, moveWindow, moveWindowTo, saveWindows, setWindowState, toggleWindow, WINDOW_TITLES, type BirdAmpWindow, type BirdAmpWindows } from './windows';

/**
 * BirdAmp Hybrid (DECISIONS.md #110, #111): the classic player window on top, the playlist below, the confidence
 * strip between them, drawn as close to Winamp 2.x as the app's real data allows: ridged gold title bars, docked
 * windows, clock and oscilloscope (the live waveform) side by side, LCD info boxes, a volume-style meter, one row
 * of transport keys with EQ and PL, a green-on-black playlist with the current bird on a navy bar, and a one-line
 * windowshade. Presentation only: it shows the same canvases, session birds and controls as the other layouts
 * (the canvases are moved in, never copied), and every element drawn as a button does something. Readouts the app
 * has no control for (mic gain, the area filter) are drawn as LCD text.
 */
export interface BirdAmpParts {
  controller: AppController;
  waveCanvas: HTMLCanvasElement;
  specBox: HTMLElement;
  timelineCanvas: HTMLCanvasElement;
  legend: HTMLElement;
  /** "N birds not usual here · show" and its list, kept with the playlist. */
  notUsualBox: HTMLElement;
  waveform: WaveformView;
  spectrogram: SpectrogramView;
  /** The Listen state as the other layouts see it. */
  status: () => ListenStatus;
  /** The status line's words ("Near Johnston · November birds · Only matches 70% or more"). */
  areaText: () => string;
  /** The town for NEAR YOU, when known. */
  place: () => string | null;
  start: () => void;
  pause: () => void;
  stop: () => void;
  sample: () => void;
}

export interface BirdAmpView {
  el: HTMLElement;
  /** Move the shared canvases in (the layout switched to BirdAmp). */
  mount: () => void;
  /** State, clock, transport, marquee and the playlist. */
  render: () => void;
  /** Every animation frame while shown: the gain readout. */
  tick: () => void;
  setClock: (sec: number) => void;
  setLevel: (level: number) => void;
  /** "Sample analysed in 247 ms." after the sample clip. */
  setReadout: (text: string) => void;
  /** A window was analysed: the newest bird goes back into the marquee. */
  onResult: () => void;
  dispose: () => void;
}

const btn = (cls: string, label: string, text: string, testid: string) => el('button', { class: cls, type: 'button', 'aria-label': label, 'data-testid': testid }, text);

export function birdAmpView(p: BirdAmpParts): BirdAmpView {
  const { controller } = p;
  let windows: BirdAmpWindows = loadWindows();
  let tab: LibraryTab = 'heard';
  let query = '';
  /** Which session bird the marquee shows: 0 is the newest; PREV and NEXT step through them. */
  let selected = 0;
  let readout = '';
  let disposed = false;

  // ---- player ------------------------------------------------------------------
  // Left LCD: the play-state symbol and the big clock over the oscilloscope (the live waveform).
  const stateWord = el('span', { class: 'sr-only' }, '');
  const stateSymbol = el('span', { class: 'ba-ps', 'aria-hidden': 'true' }, '■');
  const stateLabel = el('span', { class: 'ba-state', 'data-testid': 'ba-state' }, stateSymbol, stateWord);
  const clock = el('span', { class: 'ba-clock tabular', 'data-testid': 'ba-clock' }, '00:00');
  const visSlot = el('div', { class: 'ba-vis', 'aria-label': 'Live waveform, auto-scaled' });
  const lcdLeft = el('div', { class: 'ba-lcd ba-lcd-left' }, el('div', { class: 'ba-clockrow' }, stateLabel, clock), visSlot);
  // Right LCD: the scrolling title, the info boxes (Winamp's kbps / kHz and mono / stereo), the meter.
  const marqueeText = el('span', { class: 'ba-marquee-text' }, '');
  const marquee = el('div', { class: 'ba-marquee', 'data-testid': 'ba-marquee', role: 'status', 'aria-live': 'polite' }, marqueeText);
  const info = el(
    'div',
    { class: 'ba-info', 'data-testid': 'ba-info', 'aria-label': '48 kHz, BirdNET 2.4, mono' },
    el('span', { class: 'ba-ib' }, '48'),
    el('small', null, 'kHz'),
    el('span', { class: 'ba-ib' }, '2.4'),
    el('small', null, 'BirdNET'),
    el('span', { class: 'ba-light on' }, 'Mono'),
    el('span', { class: 'ba-light' }, 'Stereo'),
  );
  // Shaped like Winamp's volume slider, with no knob: the waveform gain is automatic, so this is display only.
  const meterFill = el('i');
  const meterText = el('em', { 'data-testid': 'ba-gain' }, 'Gain ×1 · auto');
  const meter = el('div', { class: 'ba-meter', title: 'Mic level; the waveform gain is set automatically (display only)' }, meterFill, meterText);
  const readoutLine = el('div', { class: 'ba-readout', 'data-testid': 'ba-readout', hidden: true }, '');
  const lcdRight = el('div', { class: 'ba-lcd ba-lcd-right' }, marquee, info, meter, readoutLine);
  const specSlot = el('div', { class: 'ba-spec' });
  const tKey = (icon: string, word: string, label: string, testid: string) =>
    el('button', { class: 'ba-key', type: 'button', 'aria-label': label, 'data-testid': testid }, el('span', { class: 'ba-key-icon', 'aria-hidden': 'true' }, icon), el('span', { class: 'ba-key-word', 'aria-hidden': 'true' }, word));
  const prevBtn = tKey('⏮', 'Prev', 'Previous bird', 'ba-prev');
  const listenBtn = tKey('▶', 'Listen', 'Listen', 'ba-listen');
  const pauseBtn = tKey('❚❚', 'Pause', 'Pause', 'ba-pause');
  const stopBtn = tKey('■', 'Stop', 'Stop', 'ba-stop');
  const nextBtn = tKey('⏭', 'Next', 'Next bird', 'ba-next');
  const sampleBtn = tKey('⏏', 'Sample', 'Try the sample clip', 'ba-sample');
  const eqBtn = el('button', { class: 'ba-toggle', type: 'button', 'aria-label': 'Show or hide the Confidence window', 'aria-pressed': 'true', 'data-testid': 'ba-eq' }, 'EQ');
  const plBtn = el('button', { class: 'ba-toggle', type: 'button', 'aria-label': 'Show or hide the Playlist window', 'aria-pressed': 'true', 'data-testid': 'ba-pl' }, 'PL');
  const transport = el('div', { class: 'ba-transport' }, prevBtn, listenBtn, pauseBtn, stopBtn, nextBtn, sampleBtn, el('span', { class: 'ba-eqpl' }, eqBtn, plBtn));
  // The area filter is shown, not set, here: it is edited in Settings.
  const area = el('a', { class: 'ba-area', href: '#/settings', 'data-testid': 'ba-area' }, '');
  const playerBody = el('div', { class: 'ba-body' }, el('div', { class: 'ba-main' }, lcdLeft, lcdRight), specSlot, transport, area);

  // ---- confidence ----------------------------------------------------------------
  const minLabel = el('span', { class: 'ba-min', 'data-testid': 'ba-min' }, '');
  const confSlot = el('div', { class: 'ba-conf' }, minLabel);
  const legendSlot = el('div', { class: 'ba-legend' });
  const confBody = el('div', { class: 'ba-body' }, confSlot, legendSlot);

  // ---- playlist ---------------------------------------------------------------------
  const tabBtns = new Map<LibraryTab, HTMLButtonElement>();
  const tabRow = el('div', { class: 'ba-tabs', role: 'tablist', 'aria-label': 'Playlist' });
  for (const t of LIBRARY_TABS) {
    const b = el('button', { class: 'ba-tab', type: 'button', role: 'tab', 'aria-selected': 'false', 'aria-controls': 'ba-rows', 'data-testid': `ba-tab-${t.id}` }, t.label);
    b.addEventListener('click', () => {
      tab = t.id;
      search.placeholder = t.search;
      renderLibrary(true);
    });
    tabBtns.set(t.id, b);
    tabRow.appendChild(b);
  }
  const search = el('input', { class: 'ba-search', type: 'search', placeholder: LIBRARY_TABS[0].search, 'aria-label': 'Search the playlist', 'data-testid': 'ba-search', autocomplete: 'off' }) as HTMLInputElement;
  search.addEventListener('input', () => {
    query = search.value;
    renderLibrary(false);
  });
  const note = el('p', { class: 'ba-note', 'data-testid': 'ba-libnote', hidden: true }, '');
  const rows = el('div', { class: 'ba-rows', id: 'ba-rows', role: 'tabpanel', 'data-testid': 'ba-rows' });
  const moreText = el('p', { class: 'ba-note', hidden: true }, '');
  // Winamp's playlist foot: search on the left, the total box where Winamp shows the total time.
  const total = el('span', { class: 'ba-total', 'data-testid': 'ba-libcount' }, '');
  const foot = el('div', { class: 'ba-plfoot' }, el('label', { class: 'ba-searchbox' }, el('span', { 'aria-hidden': 'true' }, '⌕'), search), total);
  const libBody = el('div', { class: 'ba-body' }, tabRow, note, rows, moreText, foot);

  // ---- windows ----------------------------------------------------------------------
  const sections = new Map<BirdAmpWindow, HTMLElement>();
  const shadeText = new Map<BirdAmpWindow, HTMLElement>();
  const stack = el('div', { class: 'ba-stack' });
  const hiddenBar = el('div', { class: 'ba-hiddenbar', 'data-testid': 'ba-hidden-bar', hidden: true });

  const save = (next: BirdAmpWindows) => {
    windows = next;
    saveWindows(windows);
    renderWindows();
  };
  // Player windowshade parts: clock, play-state, the bird, and play / pause / stop.
  const shadeClock = el('span', { class: 'ba-shade-clock tabular' }, '00:00');
  const shadeState = el('span', { class: 'ba-ps', 'aria-hidden': 'true' }, '■');
  const shadeListen = btn('ba-mini', 'Listen', '▶', 'ba-shade-listen');
  const shadePause = btn('ba-mini', 'Pause', '❚❚', 'ba-shade-pause');
  const shadeStop = btn('ba-mini', 'Stop', '■', 'ba-shade-stop');
  const bodies: Record<BirdAmpWindow, HTMLElement> = { player: playerBody, confidence: confBody, library: libBody };

  for (const id of ['player', 'confidence', 'library'] as const) {
    const title = WINDOW_TITLES[id];
    const grip = el('button', { class: 'ba-grip', type: 'button', 'aria-label': `Move the ${title} window (arrow keys move it up or down)`, 'data-testid': `ba-grip-${id}` }, '⠿');
    const minBtn = btn('ba-wbtn', `Windowshade ${title}`, '_', `ba-min-${id}`);
    const maxBtn = btn('ba-wbtn', `Full size ${title}`, '▢', `ba-max-${id}`);
    const closeBtn = btn('ba-wbtn', `Close ${title}`, '×', `ba-close-${id}`);
    minBtn.addEventListener('click', () => save(setWindowState(windows, id, 'min')));
    maxBtn.addEventListener('click', () => save(setWindowState(windows, id, 'open')));
    closeBtn.addEventListener('click', () => save(setWindowState(windows, id, 'closed')));
    moveByKeys(grip, id);
    dragByGrip(grip, id);
    const bar = el('div', { class: 'ba-titlebar' }, grip, el('span', { class: 'ba-ridges', 'aria-hidden': 'true' }), el('span', { class: 'ba-title' }, title), el('span', { class: 'ba-ridges', 'aria-hidden': 'true' }), el('span', { class: 'ba-wbtns' }, minBtn, maxBtn, closeBtn));
    // Windowshade: the whole window becomes one thin bar, as in Winamp; ▢ brings it back.
    const shadeGrip = el('button', { class: 'ba-grip', type: 'button', 'aria-label': `Move the ${title} window (arrow keys move it up or down)` }, '⠿');
    moveByKeys(shadeGrip, id);
    dragByGrip(shadeGrip, id);
    const unshade = btn('ba-wbtn', `Full size ${title}`, '▢', `ba-unshade-${id}`);
    unshade.addEventListener('click', () => save(setWindowState(windows, id, 'open')));
    const text = el('span', { class: 'ba-shade-text', 'data-testid': id === 'player' ? 'ba-shade-bird' : `ba-shade-${id}` }, '');
    shadeText.set(id, text);
    const shade =
      id === 'player'
        ? el('div', { class: 'ba-shade', 'data-testid': 'ba-shade' }, shadeGrip, shadeState, shadeClock, text, shadeListen, shadePause, shadeStop, unshade)
        : el('div', { class: 'ba-shade', 'data-testid': `ba-shade-bar-${id}` }, shadeGrip, el('span', { class: 'ba-title' }, title), text, unshade);
    const section = el('section', { class: 'ba-win', 'data-win': id, 'data-testid': `ba-win-${id}`, 'aria-label': title }, bar, bodies[id], shade);
    sections.set(id, section);
  }
  const root = el('div', { class: 'birdamp', 'data-testid': 'birdamp' }, hiddenBar, stack);

  function moveByKeys(grip: HTMLElement, id: BirdAmpWindow) {
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      save(moveWindow(windows, id, e.key === 'ArrowUp' ? -1 : 1));
      grip.focus();
    });
  }

  /** Drag a window by its grip: it slots in live as it passes the middle of a neighbour. Touch and mouse alike. */
  function dragByGrip(grip: HTMLElement, id: BirdAmpWindow) {
    let dragging = false;
    grip.addEventListener('pointerdown', (e) => {
      dragging = true;
      grip.setPointerCapture?.(e.pointerId);
      sections.get(id)?.classList.add('dragging');
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const others = windows.order.filter((w) => w !== id && windows.state[w] !== 'closed');
      let index = 0;
      for (const w of others) {
        const r = sections.get(w)!.getBoundingClientRect();
        if (e.clientY > r.top + r.height / 2) index++;
      }
      // Map the index among visible windows back onto the full order (closed windows keep their places).
      const target = index < others.length ? windows.order.indexOf(others[index]) : windows.order.length;
      const current = windows.order.indexOf(id);
      const next = moveWindowTo(windows, id, target > current ? target - 1 : target);
      if (next.order.join() !== windows.order.join()) {
        windows = next;
        renderWindows();
      }
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      sections.get(id)?.classList.remove('dragging');
      save(windows);
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  function renderWindows() {
    const shown: HTMLElement[] = [];
    for (const id of windows.order) {
      const section = sections.get(id)!;
      const st = windows.state[id];
      section.dataset.state = st;
      (section.querySelector(`[data-testid="ba-min-${id}"]`) as HTMLButtonElement).disabled = st === 'min';
      (section.querySelector(`[data-testid="ba-max-${id}"]`) as HTMLButtonElement).disabled = st === 'open';
      if (st !== 'closed') shown.push(section);
    }
    syncChildren(stack, shown);
    const hidden = hiddenWindows(windows);
    hiddenBar.hidden = hidden.length === 0;
    hiddenBar.replaceChildren(
      el('span', null, 'Windows hidden:'),
      ...hidden.map((id) => {
        const b = el('button', { class: 'ba-restore', type: 'button', 'data-testid': `ba-restore-${id}` }, `${WINDOW_TITLES[id]} ▢`);
        b.addEventListener('click', () => save(setWindowState(windows, id, 'open')));
        return b;
      }),
    );
    eqBtn.setAttribute('aria-pressed', String(windows.state.confidence === 'open'));
    plBtn.setAttribute('aria-pressed', String(windows.state.library === 'open'));
  }
  eqBtn.addEventListener('click', () => save(toggleWindow(windows, 'confidence')));
  plBtn.addEventListener('click', () => save(toggleWindow(windows, 'library')));

  // ---- transport -------------------------------------------------------------------------
  const birds = () => groupRecent(controller.getSessionHits());
  prevBtn.addEventListener('click', () => {
    const n = birds().length;
    if (n > 1) selected = (selected + 1) % n; // older
    render();
  });
  nextBtn.addEventListener('click', () => {
    const n = birds().length;
    if (n > 1) selected = (selected - 1 + n) % n; // newer
    render();
  });
  for (const b of [listenBtn, shadeListen]) b.addEventListener('click', () => p.start());
  for (const b of [pauseBtn, shadePause]) b.addEventListener('click', () => p.pause());
  for (const b of [stopBtn, shadeStop]) b.addEventListener('click', () => p.stop());
  sampleBtn.addEventListener('click', () => p.sample());

  // ---- playlist data --------------------------------------------------------------------------
  let sightings: SightingRecord[] | null = null;
  let spotted: Set<string> | null = null;
  let loading = false;
  const loadSaved = async () => {
    if (loading) return;
    loading = true;
    try {
      const [s, sp] = await Promise.all([listSightings(), listSightedSpecies()]);
      sightings = s;
      spotted = new Set(sp);
    } catch {
      sightings = [];
      spotted = new Set();
    } finally {
      loading = false;
    }
    if (!disposed) renderLibrary(false);
  };
  const rowPool = keyedPool<{ el: HTMLElement; dispose: () => void; set: (r: LibraryRow, n: number, current: boolean) => void }>();
  const makeRow = (scientific: string) => {
    const name = el('span', { class: 'ba-row-name' }, '');
    const right = el('span', { class: 'ba-row-right' }, '');
    const detail = el('span', { class: 'ba-row-detail' }, '');
    const a = el('a', { class: 'ba-row', href: hrefFor({ name: 'species-detail', scientific }), 'data-testid': 'ba-row', 'data-species': scientific }, name, right, detail);
    return {
      el: a,
      dispose: () => undefined,
      set(r: LibraryRow, n: number, current: boolean) {
        const label = `${n}. ${r.common}`;
        if (name.textContent !== label) name.textContent = label;
        const d = r.detail || r.scientific;
        if (detail.textContent !== d) detail.textContent = d;
        if (right.textContent !== r.right) right.textContent = r.right;
        a.classList.toggle('current', current);
        if (current) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      },
    };
  };
  const MAX_ROWS = 120;

  function renderLibrary(tabChanged: boolean) {
    for (const [id, b] of tabBtns) {
      b.setAttribute('aria-selected', String(id === tab));
      b.tabIndex = id === tab ? 0 : -1;
    }
    let all: LibraryRow[] = [];
    let totalWords: string;
    let empty: string;
    let currentKey: string | null = null;
    if (tab === 'heard') {
      const groups = birds();
      all = heardRows(groups);
      currentKey = groups[selected]?.key ?? null;
      totalWords = totalText('heard', { rows: groups.length, detections: groups.reduce((n, g) => n + g.detections.length, 0) });
      empty = emptyText('heard');
    } else if (tab === 'today' || tab === 'all') {
      if (!sightings) {
        void loadSaved();
        totalWords = '…';
        empty = 'Loading…';
      } else {
        all = sightingRows(sightings, tab === 'today' ? { since: startOfDay(Date.now()) } : {});
        totalWords = totalText(tab, { rows: all.length });
        empty = emptyText(tab);
      }
    } else {
      if (!spotted) void loadSaved();
      const local = controller.getLocalSpecies();
      const includeNonBird = controller.settings.get().includeNonBird;
      const list = [...(local.indices ?? [])].map((i) => controller.species[i]).filter((s): s is NonNullable<typeof s> => !!s && (s.isBird || includeNonBird));
      all = local.indices ? nearRows(list, spotted ?? new Set()) : [];
      totalWords = totalText('near', { rows: all.length, place: p.place() });
      empty = emptyText('near', local.indices ? null : local.note);
    }
    const filtered = filterRows(all, query);
    const shown = filtered.slice(0, MAX_ROWS);
    total.textContent = query.trim() && all.length ? `${filtered.length} of ${totalWords}` : totalWords;
    note.hidden = all.length > 0;
    note.textContent = empty;
    moreText.hidden = filtered.length <= MAX_ROWS;
    moreText.textContent = `Showing ${MAX_ROWS} of ${filtered.length} · search to narrow`;
    syncChildren(
      rows,
      shown.map((r, i) => {
        const row = rowPool.take(`${tab}:${r.scientific}`, () => makeRow(r.scientific));
        row.set(r, i + 1, r.scientific === currentKey);
        return row.el;
      }),
    );
    rowPool.sweep();
    if (tabChanged) rows.scrollTop = 0;
    const groups = birds();
    shadeText.get('library')!.textContent = totalText('heard', { rows: groups.length, detections: groups.reduce((n, g) => n + g.detections.length, 0) });
  }

  // ---- state -----------------------------------------------------------------------------------
  let lastClock = -1;
  function render() {
    const st = p.status();
    const paused = controller.paused;
    const live = st === 'listening';
    const canStart = st === 'ready' || st === 'offline' || st === 'idle';
    root.dataset.status = paused ? 'held' : st;
    const symbol = live ? '▶' : paused || st === 'paused' ? '❚❚' : '■';
    stateSymbol.textContent = symbol;
    shadeState.textContent = symbol;
    stateWord.textContent = live ? 'Live' : paused || st === 'paused' ? 'Paused' : 'Ready';
    const groups = birds();
    if (selected >= groups.length) selected = 0;
    const bird = groups[selected];
    const text = paused
      ? `Paused · ▶ to go on${groups[0] ? ` · Last: ${groups[0].species.common} ${Math.round(groups[0].best * 100)}%` : ''}`
      : bird
        ? marqueeBird(bird.species, bird.best)
        : live
          ? 'Listening… birds appear here'
          : 'Ready · ▶ to listen';
    if (marqueeText.textContent !== text) {
      marqueeText.textContent = text;
      fitMarquee();
    }
    shadeText.get('player')!.textContent = bird ? `${bird.species.common} ${Math.round(bird.best * 100)}%` : paused ? 'Paused' : live ? 'Listening…' : 'Ready';
    listenBtn.setAttribute('aria-label', paused ? 'Carry on listening' : 'Listen');
    shadeListen.setAttribute('aria-label', paused ? 'Carry on listening' : 'Listen');
    listenBtn.disabled = shadeListen.disabled = !(canStart || paused) || live;
    pauseBtn.disabled = shadePause.disabled = !live;
    stopBtn.disabled = shadeStop.disabled = !(live || paused || st === 'paused');
    prevBtn.disabled = nextBtn.disabled = groups.length < 2;
    sampleBtn.disabled = !canStart || live;
    listenBtn.classList.toggle('lit', live);
    pauseBtn.classList.toggle('lit', paused);
    const areaWords = p.areaText();
    if (area.textContent !== areaWords) area.textContent = areaWords;
    minLabel.textContent = `Min ${Math.round(controller.settings.get().threshold * 100)}%`;
    shadeText.get('confidence')!.textContent = groups.length ? groups.slice(0, 3).map((g) => `${g.species.common} ${Math.round(g.best * 100)}%`).join(' · ') : 'No birds yet';
    readoutLine.hidden = readout === '' || live;
    readoutLine.textContent = readout;
    renderLibrary(false);
  }

  /** Scroll the marquee only when the words do not fit (and never with reduced motion: CSS turns it off). */
  function fitMarquee() {
    marquee.classList.remove('scroll');
    const over = marqueeText.scrollWidth - marquee.clientWidth;
    if (over > 4) {
      marquee.style.setProperty('--ba-dist', `${over + 24}px`);
      marquee.style.setProperty('--ba-dur', `${Math.max(6, (over + 24) / 30)}s`);
      marquee.classList.add('scroll');
    }
  }

  let lastGain = '';
  const unsubs = [
    controller.on('detections-changed', () => {
      sightings = null;
      spotted = null;
      if (tab !== 'heard') void loadSaved();
    }),
    controller.on('local-species', () => {
      if (tab === 'near') renderLibrary(false);
    }),
  ];

  renderWindows();
  return {
    el: root,
    mount() {
      if (p.waveCanvas.parentElement !== visSlot) visSlot.prepend(p.waveCanvas);
      if (p.specBox.parentElement !== specSlot) specSlot.appendChild(p.specBox);
      if (p.timelineCanvas.parentElement !== confSlot) confSlot.prepend(p.timelineCanvas);
      if (p.legend.parentElement !== legendSlot) legendSlot.appendChild(p.legend);
      if (p.notUsualBox.parentElement !== libBody) libBody.insertBefore(p.notUsualBox, foot);
      render();
      requestAnimationFrame(() => fitMarquee());
    },
    render,
    tick() {
      const g = `Gain ×${p.waveform.gain} · auto`;
      if (g !== lastGain) {
        lastGain = g;
        meterText.textContent = g;
      }
    },
    setClock(sec) {
      const t = lcdClock(sec);
      if (sec === lastClock) return;
      lastClock = sec;
      clock.textContent = t;
      shadeClock.textContent = t;
    },
    setLevel(level) {
      meterFill.style.width = `${levelPercent(level)}%`;
    },
    setReadout(text) {
      readout = text.trim();
      render();
    },
    onResult() {
      selected = 0;
      render();
    },
    dispose() {
      disposed = true;
      for (const u of unsubs) u();
      rowPool.clear();
    },
  };
}
