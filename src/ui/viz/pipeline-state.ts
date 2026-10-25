import type { PipelineStage } from '../../app/controller';

/**
 * Which pipeline chips are lit, kept as data so it can be tested without a browser.
 * The view (src/ui/viz/pipeline.ts) only copies this onto class names.
 *
 * One 3-second window runs the stages in order. The stage that just fired is "active";
 * the ones before it in the same window are "done"; a stage earlier than the last one
 * means a new window started, so everything resets (the controller emits `mic` for
 * every audio chunk, so a repeated `mic` must not reset anything).
 */
export const PIPELINE_STAGES: Array<{ id: PipelineStage; chip: string; title: string; text: string }> = [
  { id: 'mic', chip: 'Mic', title: 'Microphone', text: 'The mic captures sound; it stays on your phone.' },
  { id: 'resample', chip: 'Resample', title: 'Resample', text: 'Converted to mono at 48 kHz, what BirdNET expects.' },
  { id: 'window', chip: 'Window', title: 'Window', text: 'Cut into overlapping 3 s windows so no call falls between them.' },
  { id: 'spectrogram', chip: 'Spectrogram', title: 'Spectrogram', text: 'Each window becomes two pictures of pitch over time (0–3 kHz, 0.5–15 kHz).' },
  { id: 'network', chip: 'Network', title: 'Neural network', text: 'A neural network scores all 6,522 classes; several can score high.' },
  { id: 'filter', chip: 'Location', title: 'Location & season', text: 'A second model drops species not expected here this week.' },
  { id: 'result', chip: 'Result', title: 'Result', text: 'Anything above your minimum is shown.' },
];

const ORDER = new Map(PIPELINE_STAGES.map((s, i) => [s.id, i]));

/** How long a chip stays on the accent fill before it may drop to the soft tint. */
export const MIN_LIT_MS = 300;

export interface PipelineState {
  active: PipelineStage | null;
  /** Stages finished earlier in this window. */
  done: PipelineStage[];
  /** When `active` was lit, for the minimum-lit rule. */
  activeSince: number;
}

export const emptyPipelineState: PipelineState = { active: null, done: [], activeSince: 0 };

/**
 * Apply one stage event.
 *
 * `reduceMotion` follows the spec for prefers-reduced-motion: no stepping through the
 * stages, only the final `result` lights up when a window finishes.
 */
export function nextPipelineState(prev: PipelineState, stage: PipelineStage, opts: { now: number; reduceMotion?: boolean; listening?: boolean }): PipelineState {
  if (opts.listening === false) return emptyPipelineState;
  if (opts.reduceMotion) {
    return stage === 'result' ? { active: 'result', done: [], activeSince: opts.now } : prev;
  }
  const index = ORDER.get(stage);
  if (index === undefined) return prev;
  const prevIndex = prev.active ? (ORDER.get(prev.active) ?? -1) : -1;
  // A stage earlier than the last one means the next window has started.
  if (index < prevIndex) return { active: stage, done: [], activeSince: opts.now };
  if (prev.active === stage) return prev;
  const done = prev.active ? [...prev.done.filter((s) => s !== prev.active), prev.active] : prev.done;
  return { active: stage, done, activeSince: opts.now };
}

/** Class for one chip or number badge, from the state. */
export function stageClass(state: PipelineState, stage: PipelineStage): '' | 'active' | 'done' {
  if (state.active === stage) return 'active';
  return state.done.includes(stage) ? 'done' : '';
}
