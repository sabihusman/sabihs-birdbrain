import type { AppController } from '../../app/controller';
import { speciesColor } from '../../species/colors';
import { groupRecent } from '../../species/recent';
import { listSightedSpecies, listSightings } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import { el } from '../dom';
import { keyedPool, syncChildren } from '../keyed';
import { hrefFor } from '../router';
import type { ListenStatus } from '../status';
import type { SpectrogramView } from '../viz/spectrogram';
import type { WaveformView } from '../viz/waveform';
import { lcdClock, levelSegments, specLine } from './lcd';
import { countLine, filterRows, heardRows, LIBRARY_TABS, marqueeBird, nearRows, sightingRows, startOfDay, type LibraryRow, type LibraryTab } from './library';
import { hiddenWindows, loadWindows, moveWindow, moveWindowTo, saveWindows, setWindowState, toggleWindow, WINDOW_TITLES, type BirdAmpWindow, type BirdAmpWindows } from './windows';

/**
 * BirdAmp Hybrid (DECISIONS.md #110): the classic player window on top, the Library's tabs and rows below, and the
 * confidence strip between them, in a dark Winamp skin. Presentation only: it shows the same canvases, session
 * birds and controls as the other layouts (the canvases are moved in, never copied), and every element drawn as a
 * button does something. Readouts the app has no number for (mic gain, the area filter) are drawn as LCD text.
 */
export interface BirdAmpParts {
  controller: AppController;
  waveCanvas: HTMLCanvasElement;
  specBox: HTMLElement;
  timelineCanvas: HTMLCanvasElement;
  legend: HTMLElement;
  /** "N birds not usual here · show" and its list, kept with the Library. */
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
  /** State, clock, transport, marquee and the Library. */
  render: () => void;
  /** Every animation frame while shown: gain and dB readouts. */
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
  const clock = el('span', { class: 'ba-clock tabular', 'data-testid': 'ba-clock' }, '00:00');
  const stateLabel = el('span', { class: 'ba-state', 'data-testid': 'ba-state' }, '');
  const marqueeText = el('span', { class: 'ba-marquee-text' }, '');
  const marquee = el('div', { class: 'ba-marquee', 'data-testid': 'ba-marquee', role: 'status', 'aria-live': 'polite' }, marqueeText);
  const spec = el('div', { class: 'ba-specline', 'data-testid': 'ba-specline' }, '');
  const readoutLine = el('div', { class: 'ba-readout', 'data-testid': 'ba-readout', hidden: true }, '');
  const lcd = el('div', { class: 'ba-lcd' }, el('div', { class: 'ba-lcd-top' }, clock, stateLabel), marquee, spec, readoutLine);
  // The waveform canvas prints its own gain ("×25"); the meter row says it is automatic.
  const visSlot = el('div', { class: 'ba-vis', 'aria-label': 'Live waveform, auto-scaled' });
  const specSlot = el('div', { class: 'ba-spec' });
  const counts = el('span', { 'data-testid': 'ba-counts' }, 'No birds yet');
  const leds = el('span', { class: 'ba-leds', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, () => el('i')));
  const ledGain = el('span', { class: 'tabular' }, '×1');
  // Display only: BirdNET auto-scales the waveform, the user never sets a gain.
  const countRow = el('div', { class: 'ba-countrow' }, counts, el('span', { class: 'ba-meter', title: 'Waveform gain, set automatically (display only)' }, 'GAIN ', leds, ' ', ledGain));
  const tBtn = (icon: string, word: string, label: string, testid: string) => {
    const b = el('button', { class: 'ba-key', type: 'button', 'aria-label': label, 'data-testid': testid }, el('span', { class: 'ba-key-icon', 'aria-hidden': 'true' }, icon), el('span', { class: 'ba-key-word', 'aria-hidden': 'true' }, word));
    return b;
  };
  const prevBtn = tBtn('⏮', 'Prev', 'Previous bird', 'ba-prev');
  const listenBtn = tBtn('▶', 'Listen', 'Listen', 'ba-listen');
  const pauseBtn = tBtn('❚❚', 'Pause', 'Pause', 'ba-pause');
  const stopBtn = tBtn('■', 'Stop', 'Stop', 'ba-stop');
  const nextBtn = tBtn('⏭', 'Next', 'Next bird', 'ba-next');
  const sampleBtn = tBtn('⏏', 'Sample', 'Try the sample clip', 'ba-sample');
  const transport = el('div', { class: 'ba-transport' }, prevBtn, listenBtn, pauseBtn, stopBtn, nextBtn, sampleBtn);
  // The area filter is shown, not set, here: it is edited in Settings.
  const area = el('a', { class: 'ba-area', href: '#/settings', 'data-testid': 'ba-area' }, '');
  const eqBtn = el('button', { class: 'ba-toggle', type: 'button', 'aria-label': 'Show or hide the Confidence window', 'aria-pressed': 'true', 'data-testid': 'ba-eq' }, 'EQ');
  const plBtn = el('button', { class: 'ba-toggle', type: 'button', 'aria-label': 'Show or hide the Library window', 'aria-pressed': 'true', 'data-testid': 'ba-pl' }, 'PL');
  const areaRow = el('div', { class: 'ba-arearow' }, area, eqBtn, plBtn);
  const playerBody = el('div', { class: 'ba-body' }, el('div', { class: 'ba-top' }, lcd, visSlot), specSlot, countRow, transport, areaRow);

  // Windowshade mini-player: clock, live light, the bird, and play / pause / stop.
  const shadeClock = el('span', { class: 'ba-shade-clock tabular' }, '00:00');
  const shadeDot = el('span', { class: 'ba-dot', 'aria-hidden': 'true' });
  const shadeBird = el('span', { class: 'ba-shade-bird', 'data-testid': 'ba-shade-bird' }, '');
  const shadeListen = btn('ba-mini', 'Listen', '▶', 'ba-shade-listen');
  const shadePause = btn('ba-mini', 'Pause', '❚❚', 'ba-shade-pause');
  const shadeStop = btn('ba-mini', 'Stop', '■', 'ba-shade-stop');
  const playerShade = el('div', { class: 'ba-shade', 'data-testid': 'ba-shade' }, shadeClock, shadeDot, shadeBird, shadeListen, shadePause, shadeStop);

  // ---- confidence ----------------------------------------------------------------
  const minLabel = el('span', { class: 'ba-min', 'data-testid': 'ba-min' }, '');
  const confSlot = el('div', { class: 'ba-conf' }, minLabel);
  const legendSlot = el('div', { class: 'ba-legend' });
  const confBody = el('div', { class: 'ba-body' }, confSlot, legendSlot);
  const confShade = el('div', { class: 'ba-shade' }, el('span', { class: 'ba-shade-bird', 'data-testid': 'ba-conf-shade' }, ''));

  // ---- library ---------------------------------------------------------------------
  const tabBtns = new Map<LibraryTab, HTMLButtonElement>();
  const tabRow = el('div', { class: 'ba-tabs', role: 'tablist', 'aria-label': 'Library' });
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
  const search = el('input', { class: 'ba-search', type: 'search', placeholder: LIBRARY_TABS[0].search, 'aria-label': 'Search the library', 'data-testid': 'ba-search', autocomplete: 'off' }) as HTMLInputElement;
  search.addEventListener('input', () => {
    query = search.value;
    renderLibrary(false);
  });
  const countText = el('p', { class: 'ba-countline', 'data-testid': 'ba-libcount' }, '');
  const rows = el('div', { class: 'ba-rows', id: 'ba-rows', role: 'tabpanel', 'data-testid': 'ba-rows' });
  const moreText = el('p', { class: 'ba-countline', hidden: true }, '');
  const libBody = el('div', { class: 'ba-body' }, tabRow, el('div', { class: 'ba-searchrow' }, el('span', { 'aria-hidden': 'true' }, '⌕'), search), countText, rows, moreText);
  const libShade = el('div', { class: 'ba-shade' }, el('span', { class: 'ba-shade-bird', 'data-testid': 'ba-lib-shade' }, ''));

  // ---- windows ----------------------------------------------------------------------
  const bodies: Record<BirdAmpWindow, [HTMLElement, HTMLElement]> = { player: [playerBody, playerShade], confidence: [confBody, confShade], library: [libBody, libShade] };
  const sections = new Map<BirdAmpWindow, HTMLElement>();
  const stack = el('div', { class: 'ba-stack' });
  const hiddenBar = el('div', { class: 'ba-hiddenbar', 'data-testid': 'ba-hidden-bar', hidden: true });

  const save = (next: BirdAmpWindows) => {
    windows = next;
    saveWindows(windows);
    renderWindows();
  };
  for (const id of ['player', 'confidence', 'library'] as const) {
    const title = WINDOW_TITLES[id];
    const grip = el('button', { class: 'ba-grip', type: 'button', 'aria-label': `Move the ${title} window (arrow keys move it up or down)`, 'data-testid': `ba-grip-${id}` }, '⠿');
    const minBtn = btn('ba-wbtn', `Minimise ${title}`, '_', `ba-min-${id}`);
    const maxBtn = btn('ba-wbtn', `Full size ${title}`, '▢', `ba-max-${id}`);
    const closeBtn = btn('ba-wbtn', `Close ${title}`, '×', `ba-close-${id}`);
    minBtn.addEventListener('click', () => save(setWindowState(windows, id, 'min')));
    maxBtn.addEventListener('click', () => save(setWindowState(windows, id, 'open')));
    closeBtn.addEventListener('click', () => save(setWindowState(windows, id, 'closed')));
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      save(moveWindow(windows, id, e.key === 'ArrowUp' ? -1 : 1));
      grip.focus();
    });
    dragByGrip(grip, id);
    const bar = el('div', { class: 'ba-titlebar' }, grip, el('span', { class: 'ba-title' }, title), el('span', { class: 'ba-wbtns' }, minBtn, maxBtn, closeBtn));
    const [body, shade] = bodies[id];
    const section = el('section', { class: 'ba-win', 'data-win': id, 'data-testid': `ba-win-${id}`, 'aria-label': title }, bar, body, shade);
    sections.set(id, section);
  }
  const root = el('div', { class: 'birdamp', 'data-testid': 'birdamp' }, hiddenBar, stack);

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
      const [body, shade] = bodies[id];
      body.hidden = st !== 'open';
      shade.hidden = st !== 'min';
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

  // ---- library data --------------------------------------------------------------------------
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
  const rowPool = keyedPool<{ el: HTMLElement; dispose: () => void; set: (r: LibraryRow, n: number) => void }>();
  const makeRow = (scientific: string) => {
    const sw = el('span', { class: 'ba-sw', 'aria-hidden': 'true' });
    sw.style.background = speciesColor(scientific).css;
    const name = el('span', { class: 'ba-row-name' }, '');
    const detail = el('span', { class: 'ba-row-detail' }, '');
    const right = el('span', { class: 'ba-row-right' }, '');
    const a = el('a', { class: 'ba-row', href: hrefFor({ name: 'species-detail', scientific }), 'data-testid': 'ba-row', 'data-species': scientific }, el('span', { class: 'ba-note', 'aria-hidden': 'true' }, '♪'), sw, el('span', { class: 'ba-row-text' }, name, detail), right);
    return {
      el: a,
      dispose: () => undefined,
      set(r: LibraryRow, n: number) {
        const label = `${n}. ${r.common}`;
        if (name.textContent !== label) name.textContent = label;
        const d = r.detail ? `${r.scientific} · ${r.detail}` : r.scientific;
        if (detail.textContent !== d) detail.textContent = d;
        if (right.textContent !== r.right) right.textContent = r.right;
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
    let line: string;
    if (tab === 'heard') {
      const groups = birds();
      all = heardRows(groups);
      line = countLine('heard', { rows: groups.length, detections: groups.reduce((n, g) => n + g.detections.length, 0) });
    } else if (tab === 'today' || tab === 'all') {
      if (!sightings) {
        void loadSaved();
        line = 'Loading…';
      } else {
        all = sightingRows(sightings, tab === 'today' ? { since: startOfDay(Date.now()) } : {});
        line = countLine(tab, { rows: all.length });
      }
    } else {
      if (!spotted) void loadSaved();
      const local = controller.getLocalSpecies();
      const includeNonBird = controller.settings.get().includeNonBird;
      const list = [...(local.indices ?? [])].map((i) => controller.species[i]).filter((s): s is NonNullable<typeof s> => !!s && (s.isBird || includeNonBird));
      all = local.indices ? nearRows(list, spotted ?? new Set()) : [];
      line = countLine('near', { rows: all.length, place: p.place(), noLocation: local.indices ? null : local.note });
    }
    const filtered = filterRows(all, query);
    const shown = filtered.slice(0, MAX_ROWS);
    countText.textContent = query.trim() && all.length ? `${filtered.length} of ${line}` : line;
    moreText.hidden = filtered.length <= MAX_ROWS;
    moreText.textContent = `Showing ${MAX_ROWS} of ${filtered.length} · search to narrow`;
    syncChildren(
      rows,
      shown.map((r, i) => {
        const row = rowPool.take(`${tab}:${r.scientific}`, () => makeRow(r.scientific));
        row.set(r, i + 1);
        return row.el;
      }),
    );
    rowPool.sweep();
    if (tabChanged) rows.scrollTop = 0;
    const groups = birds();
    (libShade.firstElementChild as HTMLElement).textContent = `Library · ${countLine('heard', { rows: groups.length, detections: groups.reduce((n, g) => n + g.detections.length, 0) }).split(' · repeats')[0]}`;
  }

  // ---- state -----------------------------------------------------------------------------------
  let lastClock = 0;
  function render() {
    const st = p.status();
    const paused = controller.paused;
    const live = st === 'listening';
    const canStart = st === 'ready' || st === 'offline' || st === 'idle';
    root.dataset.status = paused ? 'held' : st;
    stateLabel.textContent = live ? '▶ Live' : paused ? '❚❚ Paused' : st === 'paused' ? '❚❚ Paused' : '■ Ready';
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
    shadeBird.textContent = bird ? `${bird.species.common} · ${Math.round(bird.best * 100)}%` : paused ? 'Paused' : live ? 'Listening…' : 'Ready';
    const detections = groups.reduce((n, g) => n + g.detections.length, 0);
    counts.textContent = groups.length ? `${groups.length} bird${groups.length === 1 ? '' : 's'} · ${detections} detection${detections === 1 ? '' : 's'}` : 'No birds yet';
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
    minLabel.textContent = `Your min ${Math.round(controller.settings.get().threshold * 100)}%`;
    (confShade.firstElementChild as HTMLElement).textContent = groups.length ? `Conf · ${groups.slice(0, 3).map((g) => `${g.species.common} ${Math.round(g.best * 100)}%`).join(' · ')}` : 'Conf · no birds yet';
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
  let lastSpec = '';
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
      if (p.notUsualBox.parentElement !== libBody) libBody.appendChild(p.notUsualBox);
      render();
      requestAnimationFrame(() => fitMarquee());
    },
    render,
    tick() {
      const g = `×${p.waveform.gain} auto`;
      if (g !== lastGain) {
        lastGain = g;
        ledGain.textContent = g;
      }
      const s = specLine(p.spectrogram.dbRange);
      if (s !== lastSpec) {
        lastSpec = s;
        spec.textContent = s;
      }
    },
    setClock(sec) {
      const t = lcdClock(sec);
      if (sec === lastClock && clock.textContent === t) return;
      lastClock = sec;
      clock.textContent = t;
      shadeClock.textContent = t;
    },
    setLevel(level) {
      const lit = levelSegments(level);
      Array.from(leds.children).forEach((led, i) => led.classList.toggle('on', i < lit));
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
