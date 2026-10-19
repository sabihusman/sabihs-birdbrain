import { WINDOW_SECONDS } from '../model/constants';
import { fmtDuration, pct } from './dom';

/** "Confidence 96% · your minimum 60%" */
export function confidenceLine(best: number, threshold: number): string {
  return `Confidence ${pct(best)} · your minimum ${pct(threshold)}`;
}

export interface MatchedWindow {
  offsetSec: number;
  confidence: number;
}

/** "0:02–0:05 · 96%" for one 3 s window (the end is clipped to the recording's length). */
export function windowLine(w: MatchedWindow, durationSec: number): string {
  const end = Math.min(durationSec, w.offsetSec + WINDOW_SECONDS);
  return `${fmtDuration(w.offsetSec)}–${fmtDuration(end)} · ${pct(w.confidence)}`;
}

/** One line per matched window, in time order. */
export function windowLines(windows: MatchedWindow[], durationSec: number): string[] {
  return windows
    .slice()
    .sort((a, b) => a.offsetSec - b.offsetSec)
    .map((w) => windowLine(w, durationSec));
}
