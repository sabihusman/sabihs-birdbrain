import { describe, expect, it } from 'vitest';
import { MODEL_TOTAL_BYTES } from '../src/model/constants';
import { describeModelProgress, FROM_PHONE_TEXT, mb, PREPARING_TEXT } from '../src/ui/model-progress';

const base = { state: 'loading' as const, progress: 0, loadedBytes: 0, totalBytes: MODEL_TOTAL_BYTES };

describe('Listen panel download progress (DECISIONS.md #70)', () => {
  it('counts whole MB of the download, never above the total', () => {
    expect(mb(MODEL_TOTAL_BYTES)).toBe(78);
    expect(describeModelProgress({ ...base, phase: 'acoustic', progress: 0.44, loadedBytes: 34 * 1048576 })).toEqual({ text: 'Downloading 34 MB of 78 MB', fraction: 0.44 });
    expect(describeModelProgress({ ...base, phase: 'geo', progress: 0.64, loadedBytes: MODEL_TOTAL_BYTES * 0.64 }).text).toBe('Downloading 50 MB of 78 MB');
    expect(describeModelProgress({ ...base, phase: 'acoustic', progress: 1.2, loadedBytes: MODEL_TOTAL_BYTES + 5e6 })).toEqual({ text: 'Downloading 78 MB of 78 MB', fraction: 1 });
    expect(describeModelProgress({ ...base, phase: 'acoustic', loadedBytes: 0 }).text).toBe('Downloading 0 MB of 78 MB');
  });

  it('says in plain words what the two non-download phases are', () => {
    expect(describeModelProgress({ ...base, phase: 'backend' })).toEqual({ text: PREPARING_TEXT, fraction: 0 });
    expect(describeModelProgress({ ...base, phase: 'warmup', progress: 1, loadedBytes: MODEL_TOTAL_BYTES })).toEqual({ text: 'Preparing the model on this phone…', fraction: 1 });
  });

  it('shows nothing when nothing is loading, and copes with an unknown total', () => {
    expect(describeModelProgress({ state: 'idle', phase: null, progress: 0, loadedBytes: 0, totalBytes: 0 })).toEqual({ text: '', fraction: 0 });
    expect(describeModelProgress({ state: 'ready', phase: null, progress: 1, loadedBytes: 1, totalBytes: 1 })).toEqual({ text: '', fraction: 1 });
    expect(describeModelProgress({ state: 'error', phase: 'acoustic', progress: 0.3, loadedBytes: 1, totalBytes: 2 }).text).toBe('');
    expect(describeModelProgress({ ...base, phase: 'acoustic', totalBytes: 0, progress: 0.5 }).text).toBe('Downloading the bird model…');
  });
});

describe('progress when the model is already on the phone (DECISIONS.md #71)', () => {
  it('says it is loading the saved model, not downloading', () => {
    const p = describeModelProgress({ state: 'loading', phase: 'acoustic', progress: 0.4, loadedBytes: 30 * 1048576, totalBytes: 78 * 1048576 }, true);
    expect(p.text).toBe(FROM_PHONE_TEXT);
    expect(p.text).not.toMatch(/Downloading/);
    expect(p.fraction).toBeCloseTo(0.4);
  });
  it('keeps the plain preparing text for the warm-up step either way', () => {
    expect(describeModelProgress({ state: 'loading', phase: 'warmup', progress: 1, loadedBytes: 1, totalBytes: 1 }, true).text).toBe(PREPARING_TEXT);
  });
});
