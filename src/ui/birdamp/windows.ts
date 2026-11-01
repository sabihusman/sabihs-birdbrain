/**
 * BirdAmp's three windows (DECISIONS.md #110): their order down the screen and whether each is open, minimised
 * (a strip; for the player, the windowshade mini-player) or closed (gone, brought back from the "hidden" bar).
 * Saved per phone, so the arrangement survives restarts. Pure apart from load/save.
 */
export type BirdAmpWindow = 'player' | 'confidence' | 'library';
export type WindowState = 'open' | 'min' | 'closed';
export interface BirdAmpWindows {
  order: BirdAmpWindow[];
  state: Record<BirdAmpWindow, WindowState>;
}

export const BIRDAMP_WINDOWS_KEY = 'birdbrain.birdamp.v1';
export const WINDOW_IDS: readonly BirdAmpWindow[] = ['player', 'confidence', 'library'];
export const WINDOW_TITLES: Record<BirdAmpWindow, string> = { player: 'BirdbrainAmp', confidence: 'Confidence', library: 'BirdAmp Playlist' };
const STATES: readonly WindowState[] = ['open', 'min', 'closed'];

export function defaultWindows(): BirdAmpWindows {
  return { order: [...WINDOW_IDS], state: { player: 'open', confidence: 'open', library: 'open' } };
}

/** Anything unreadable falls back to the default; a saved order must name each window once. */
export function parseWindows(raw: string | null): BirdAmpWindows {
  const out = defaultWindows();
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<BirdAmpWindows>;
    if (Array.isArray(v.order) && v.order.length === WINDOW_IDS.length && WINDOW_IDS.every((id) => v.order!.includes(id))) out.order = [...v.order];
    for (const id of WINDOW_IDS) {
      const st = v.state?.[id];
      if (st && STATES.includes(st)) out.state[id] = st;
    }
  } catch {
    /* default */
  }
  return out;
}

/** Move a window to `index` (clamped) in the stack. */
export function moveWindowTo(w: BirdAmpWindows, id: BirdAmpWindow, index: number): BirdAmpWindows {
  const order = w.order.filter((x) => x !== id);
  order.splice(Math.max(0, Math.min(order.length, index)), 0, id);
  return { ...w, order };
}

/** One place up (-1) or down (+1): the keyboard version of dragging the grip. */
export function moveWindow(w: BirdAmpWindows, id: BirdAmpWindow, dir: -1 | 1): BirdAmpWindows {
  return moveWindowTo(w, id, w.order.indexOf(id) + dir);
}

export function setWindowState(w: BirdAmpWindows, id: BirdAmpWindow, state: WindowState): BirdAmpWindows {
  return { ...w, state: { ...w.state, [id]: state } };
}

/** EQ and PL, as in Winamp: show the window if it is not fully open, hide it if it is. */
export function toggleWindow(w: BirdAmpWindows, id: BirdAmpWindow): BirdAmpWindows {
  return setWindowState(w, id, w.state[id] === 'open' ? 'closed' : 'open');
}

export function hiddenWindows(w: BirdAmpWindows): BirdAmpWindow[] {
  return w.order.filter((id) => w.state[id] === 'closed');
}

export function loadWindows(storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null): BirdAmpWindows {
  try {
    return parseWindows(storage?.getItem(BIRDAMP_WINDOWS_KEY) ?? null);
  } catch {
    return defaultWindows();
  }
}

export function saveWindows(w: BirdAmpWindows, storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null): void {
  try {
    storage?.setItem(BIRDAMP_WINDOWS_KEY, JSON.stringify(w));
  } catch {
    /* private mode or full: the arrangement lasts for this visit */
  }
}
