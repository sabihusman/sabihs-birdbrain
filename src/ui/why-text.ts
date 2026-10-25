import { WINDOW_SECONDS } from '../model/constants';
import { fmtDuration, pct } from './dom';
/**
 * What the outline and the darkening mean, shown under the result (DECISIONS.md #62, #89). Plain words:
 * where to look, what the outline marks, and what a darker area means.
 */
export function whyExplanationText(common: string, baseline: number, maxDrop: number, offsetSec: number, timeSteps: number, freqBands: number): string[] {
  const span = `${fmtDuration(offsetSec)}–${fmtDuration(offsetSec + WINDOW_SECONDS)}`;
  return [
    `${common}: ${pct(baseline)} on the window ${span}. Silencing its most important part drops it by ${pct(maxDrop)}.`,
    `How to read it: on the spectrogram above, between ${span}, the outline in the bird's colour marks the parts of the sound the model relied on most: silencing them made the confidence fall the most. The rest of that window is darkened, more where a part mattered less. Time runs left to right, pitch from low at the bottom to high at the top.`,
    `The window was split into a ${timeSteps}×${freqBands} grid; change the detail in Settings › Analysis.`,
  ];
}

