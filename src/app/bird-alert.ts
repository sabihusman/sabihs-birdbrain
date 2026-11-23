import { LUMP_GAP_SECONDS } from '../species/recent';

/**
 * "A bird is found" alert (DECISIONS.md #134): a short coloured flash at the screen's edge on every phone, and a short
 * buzz where the browser allows websites to vibrate (Android). iPhones do not: Safari has no vibration for websites,
 * and the switch-tick workaround stopped working without a real tap in iOS 26.5.
 *
 * A bird counts as found the first time it is heard in a listening session, and again after 30 s without it (the same
 * gap that makes "Heard 3 times" on its card), so a bird singing steadily alerts once, not every window.
 */
export const ALERT_GAP_MS = LUMP_GAP_SECONDS * 1000;
/** One short buzz, in milliseconds. */
export const VIBRATE_MS = 120;

export class NewBirdTracker {
  private lastHeard = new Map<string, number>();

  constructor(private readonly gapMs = ALERT_GAP_MS) {}

  /** A new listening session: every bird is new again. */
  reset(): void {
    this.lastHeard.clear();
  }

  /** The birds in this window that count as found now, in the order given. Remembers all of them as heard. */
  check(keys: readonly string[], time: number): string[] {
    const found: string[] = [];
    for (const key of new Set(keys)) {
      const last = this.lastHeard.get(key);
      if (last === undefined || time - last > this.gapMs) found.push(key);
      this.lastHeard.set(key, time);
    }
    return found;
  }
}

/** The part of `navigator` this needs (structural, so tests can pass a stand-in). */
export interface Vibrator {
  vibrate?: (pattern: number) => boolean;
}

const defaultNavigator = (): Vibrator | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as unknown as Vibrator));

/** Whether this browser offers vibration to websites at all (Android browsers do, iPhone browsers do not). */
export function canVibrate(nav: Vibrator | undefined = defaultNavigator()): boolean {
  return typeof nav?.vibrate === 'function';
}

/** One short buzz; false when the browser has no vibration or refused (it needs a tap on the page first). */
export function buzz(nav: Vibrator | undefined = defaultNavigator()): boolean {
  if (!nav?.vibrate) return false;
  try {
    return nav.vibrate(VIBRATE_MS);
  } catch {
    return false;
  }
}
