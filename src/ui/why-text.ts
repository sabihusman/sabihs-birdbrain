import { WINDOW_SECONDS } from '../model/constants';
import { fmtDuration, pct } from './dom';
/**
 * What the outline and the darkening mean, shown under the result (DECISIONS.md #62, #89). Plain words:
 * where to look, what the outline marks, and what a darker area means.
 */
export function whyExplanationText(common: string, baseline: number, maxDrop: number, offsetSec: number, timeSteps: number, freqBands: number): string[] {
  const span = `${fmtDuration(offsetSec)}–${fmtDuration(offsetSec + WINDOW_SECONDS)}`;
  return [
    `${common}: ${pct(baseline)} on ${span}. Muting the key part drops it by ${pct(maxDrop)}.`,
    `Outlined: what the ID relied on most. Darker: mattered less. Time runs left to right, pitch low to high.`,
    `${timeSteps}×${freqBands} grid · Settings › Analysis to change.`,
  ];
}

