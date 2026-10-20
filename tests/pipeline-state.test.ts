import { describe, expect, it } from 'vitest';
import { emptyPipelineState, MIN_LIT_MS, nextPipelineState, PIPELINE_STAGES, stageClass, type PipelineState } from '../src/ui/viz/pipeline-state';
import type { PipelineStage } from '../src/app/controller';

/** Walk a list of stage events through the reducer. */
function run(stages: PipelineStage[], opts: { reduceMotion?: boolean; from?: PipelineState } = {}): PipelineState {
  let state = opts.from ?? emptyPipelineState;
  stages.forEach((s, i) => {
    state = nextPipelineState(state, s, { now: i * MIN_LIT_MS, reduceMotion: opts.reduceMotion });
  });
  return state;
}
const classes = (s: PipelineState) => PIPELINE_STAGES.map((st) => `${st.chip}:${stageClass(s, st.id) || 'plain'}`);

describe('pipeline chips (DECISIONS.md #57)', () => {
  it('names the seven stages in the order the audio takes', () => {
    expect(PIPELINE_STAGES.map((s) => s.chip)).toEqual(['Mic', 'Resample', 'Window', 'Spectrogram', 'Network', 'Location', 'Result']);
    expect(PIPELINE_STAGES.map((s) => s.id)).toEqual(['mic', 'resample', 'window', 'spectrogram', 'network', 'filter', 'result']);
  });

  it('starts with every chip plain', () => {
    expect(classes(emptyPipelineState).every((c) => c.endsWith(':plain'))).toBe(true);
  });

  it('lights the running stage and tints the ones already done in this window', () => {
    const state = run(['mic', 'window', 'spectrogram', 'network']);
    expect(classes(state)).toEqual(['Mic:done', 'Resample:plain', 'Window:done', 'Spectrogram:done', 'Network:active', 'Location:plain', 'Result:plain']);
  });

  it('keeps Resample plain on a device that already records at 48 kHz', () => {
    const state = run(['mic', 'window', 'spectrogram']);
    expect(stageClass(state, 'resample')).toBe('');
  });

  it('clears the tints when the next window starts', () => {
    const first = run(['mic', 'window', 'spectrogram', 'network', 'filter', 'result']);
    expect(stageClass(first, 'result')).toBe('active');
    const second = nextPipelineState(first, 'mic', { now: 999 });
    expect(classes(second)).toEqual(['Mic:active', 'Resample:plain', 'Window:plain', 'Spectrogram:plain', 'Network:plain', 'Location:plain', 'Result:plain']);
  });

  it('ignores a repeated stage, because the mic fires for every audio chunk', () => {
    const once = run(['mic']);
    const twice = nextPipelineState(once, 'mic', { now: 500 });
    expect(twice).toBe(once);
    expect(stageClass(twice, 'mic')).toBe('active');
  });

  it('with reduce motion, only a finished window lights Result', () => {
    const state = run(['mic', 'window', 'spectrogram', 'network', 'filter'], { reduceMotion: true });
    expect(classes(state).every((c) => c.endsWith(':plain'))).toBe(true);
    const done = nextPipelineState(state, 'result', { now: 10, reduceMotion: true });
    expect(classes(done)).toEqual(['Mic:plain', 'Resample:plain', 'Window:plain', 'Spectrogram:plain', 'Network:plain', 'Location:plain', 'Result:active']);
  });

  it('clears everything when the mic stops', () => {
    const state = run(['mic', 'window', 'spectrogram']);
    const stopped = nextPipelineState(state, 'network', { now: 1, listening: false });
    expect(stopped).toEqual(emptyPipelineState);
  });

  it('holds a chip for at least 300 ms', () => {
    // The view spaces its changes by this much; the number is the contract between them.
    expect(MIN_LIT_MS).toBe(300);
  });
});
