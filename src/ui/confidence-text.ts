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

/**
 * Confidence in words next to the number, on Focus's big card (DECISIONS.md #109; cut-offs from Sabih's 5A).
 * About BirdNET's score for this species, not a calibrated probability.
 */
export const VERY_LIKELY = 0.9;
export const LIKELY = 0.7;
export function confidenceWords(p: number): 'Very likely' | 'Likely' | 'Possible' {
  // Judged on the percentage the card shows, so "Likely · 90%" can never appear.
  const pct = Math.round(p * 100);
  return pct >= VERY_LIKELY * 100 ? 'Very likely' : pct >= LIKELY * 100 ? 'Likely' : 'Possible';
}
