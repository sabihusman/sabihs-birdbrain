/**
 * Focus layout: the big "Start listening" page is an introduction, shown once per browsing
 * session and day (DECISIONS.md #83). After the first start it gives way to the bird card with
 * the controls pinned above the tab bar, and stopping keeps the birds on screen.
 *
 * sessionStorage ends with the tab or browser session; the stored day makes it come back on a
 * new day even when the session lives on (an installed app that is never closed).
 */
import { localDay } from '../species/sharing';

export const FOCUS_INTRO_KEY = 'birdbrain.focus-intro.v1';

function defaultStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** True once the person started listening in this session, today. A storage that throws reads as "not yet". */
export function focusIntroDone(storage: Storage | null = defaultStorage(), now = Date.now()): boolean {
  try {
    return storage?.getItem(FOCUS_INTRO_KEY) === localDay(now);
  } catch {
    return false;
  }
}

export function markFocusIntroDone(storage: Storage | null = defaultStorage(), now = Date.now()): void {
  try {
    storage?.setItem(FOCUS_INTRO_KEY, localDay(now));
  } catch {
    /* no storage: the introduction shows again, which is harmless */
  }
}
