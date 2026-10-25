import type { OcclusionResolution } from '../app/settings';
import { OCCLUSION_GRIDS } from '../model/occlusion';

/**
 * How detailed "Why this ID" runs on this phone (DECISIONS.md #85). With WebGL each model pass is
 * quick; on the WebAssembly or plain JavaScript fallback a pass can take seconds, so the chosen
 * detail level (Medium by default, 49 passes) could keep the phone busy for minutes. There it runs
 * Coarse (25 passes) and offers the chosen level as a second, explicit button with its time.
 */
export interface WhyPlan {
  /** What runs by default. */
  resolution: OcclusionResolution;
  passes: number;
  /** The level from Settings, offered separately when `reduced`. */
  chosen: OcclusionResolution;
  chosenPasses: number;
  /** True when this phone runs the model without WebGL and the chosen level is finer than Coarse. */
  reduced: boolean;
  /** Milliseconds per model pass measured on this phone, if any. */
  perPassMs: number | null;
}

export const RESOLUTION_NAME: Record<OcclusionResolution, string> = { coarse: 'Coarse', medium: 'Medium', fine: 'Fine' };

export function passesFor(r: OcclusionResolution): number {
  const g = OCCLUSION_GRIDS[r];
  return g.timeSteps * g.freqBands + 1;
}

export function isSlowBackend(backend: string | null | undefined): boolean {
  return backend === 'wasm' || backend === 'cpu';
}

export function planWhy(chosen: OcclusionResolution, backend: string | null | undefined, perPassMs: number | null): WhyPlan {
  const reduced = isSlowBackend(backend) && chosen !== 'coarse';
  const resolution = reduced ? 'coarse' : chosen;
  return { resolution, passes: passesFor(resolution), chosen, chosenPasses: passesFor(chosen), reduced, perPassMs: perPassMs && perPassMs > 0 ? perPassMs : null };
}

/** "about 40 s" / "about 2 min"; empty when nothing was measured yet. */
export function estimateText(passes: number, perPassMs: number | null): string {
  if (!perPassMs) return '';
  const sec = (passes * perPassMs) / 1000;
  if (sec < 10) return 'a few seconds';
  if (sec < 90) return `about ${Math.round(sec / 5) * 5} s`;
  return `about ${Math.round(sec / 60)} min`;
}

/** The line under the button: what runs and why, with the time when known. */
export function whyPlanNote(plan: WhyPlan): string {
  const est = estimateText(plan.passes, plan.perPassMs);
  const runs = `${RESOLUTION_NAME[plan.resolution]} detail, ${plan.passes} model passes${est ? `, ${est}` : ''}`;
  return plan.reduced ? `${runs}. Less detail on this phone (no graphics acceleration) to save time and battery.` : `${runs}.`;
}

/** The second button on a slow phone, e.g. "Run at Medium (49 passes, about 2 min)". */
export function chosenButtonText(plan: WhyPlan): string {
  const est = estimateText(plan.chosenPasses, plan.perPassMs);
  return `Run at ${RESOLUTION_NAME[plan.chosen]} (${plan.chosenPasses} passes${est ? `, ${est}` : ''})`;
}
