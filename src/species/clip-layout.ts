/**
 * Data preparation for the ID card's clip view, kept free of the DOM so the
 * geometry and the wording are unit-tested: which spans to outline on the
 * spectrogram, where the playback cursor sits, and how the windows are
 * described. Drawing lives in src/ui/viz/spectrogram.ts.
 */
import { WINDOW_SECONDS } from '../model/constants';
import type { ClipRecord, ClipWindow } from '../storage/types';
import { timeToX } from '../ui/viz/static-spectrogram';
import { clipWindows } from './clips';

/** One sentence shown wherever the identifying windows are: what an outlined window means. */
export const WINDOW_MEANING = 'BirdNET marks when a species is heard, not which of the overlapping sounds it is. Other birds may be audible in the clip.';

export interface OutlineSpan {
  startSec: number;
  endSec: number;
  confidence: number;
  /** Confidence as "73%". */
  label: string;
}

/** Spans to outline on the clip spectrogram, clamped to the clip; null when the clip has unknown windows. */
export function outlineSpans(clip: Pick<ClipRecord, 'windows' | 'durationSec'>, windowSec = WINDOW_SECONDS): OutlineSpan[] | null {
  const windows = clipWindows(clip);
  if (!windows) return null;
  const spans: OutlineSpan[] = [];
  for (const w of windows) {
    const startSec = Math.max(0, w.offsetSec);
    const endSec = Math.min(clip.durationSec, w.offsetSec + windowSec);
    if (endSec <= startSec) continue;
    spans.push({ startSec, endSec, confidence: w.confidence, label: `${Math.round(w.confidence * 100)}%` });
  }
  return spans;
}

/**
 * Where the playback cursor sits, in clip seconds: null when the player is
 * stopped at the start (nothing to show), otherwise the time clamped to the
 * clip. The pixel position follows from cursorX.
 */
export function cursorSec(paused: boolean, currentTime: number, durationSec: number): number | null {
  if (paused && currentTime <= 0) return null;
  if (!(durationSec > 0)) return null;
  return Math.max(0, Math.min(durationSec, currentTime));
}

/** Pixel x of a cursor at `sec` for a clip `durationSec` long drawn `width` wide (what the overlay draws). */
export function cursorX(sec: number | null, durationSec: number, width: number): number | null {
  if (sec == null || !(durationSec > 0)) return null;
  return timeToX(Math.max(0, Math.min(durationSec, sec)), 0, durationSec, width);
}

/** Seconds at a tap on the spectrogram, clamped to the clip. */
export function seekSecAt(x: number, width: number, durationSec: number): number {
  if (!(width > 0) || !(durationSec > 0)) return 0;
  return Math.max(0, Math.min(durationSec, (x / width) * durationSec));
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The windows line under the spectrogram: "Identified in 2 windows: 0:01 (73%), 0:03 (81%)",
 * or a note that an older clip did not record them.
 */
export function describeWindows(windows: ClipWindow[] | null, windowSec = WINDOW_SECONDS): string {
  if (!windows) return 'Which 3-second windows triggered this ID was not recorded (clip saved by an earlier version).';
  if (windows.length === 0) return 'No identifying window was recorded for this clip.';
  const parts = windows.map((w) => `${mmss(Math.max(0, w.offsetSec))}–${mmss(Math.max(0, w.offsetSec) + windowSec)} (${Math.round(w.confidence * 100)}%)`);
  return `Identified in ${windows.length} window${windows.length === 1 ? '' : 's'} of ${windowSec} s: ${parts.join(', ')}.`;
}
