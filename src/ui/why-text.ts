import { WINDOW_SECONDS } from '../model/constants';
import { fmtDuration, pct } from './dom';
/**
 * What the shaded boxes mean, shown under the result (DECISIONS.md #62). Plain words:
 * where to look, what stronger shading means, and what an unshaded area means.
 */
export function whyExplanationText(common: string, baseline: number, maxDrop: number, offsetSec: number, timeSteps: number, freqBands: number): string[] {
  const span = `${fmtDuration(offsetSec)}–${fmtDuration(offsetSec + WINDOW_SECONDS)}`;
  return [
    `${common}: ${pct(baseline)} on the window ${span}. Silencing its most important part drops it by ${pct(maxDrop)}.`,
    `How to read it: the coloured boxes on the spectrogram above, between ${span}, are the parts of the sound the model relied on. The stronger the colour, the more the confidence fell when that part was silenced. Clear areas barely mattered. Time runs left to right, pitch from low at the bottom to high at the top.`,
    `The window was split into a ${timeSteps}×${freqBands} grid; change the detail in Settings › Analysis.`,
  ];
}

