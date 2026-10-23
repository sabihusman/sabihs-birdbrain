import type { ModelStatus } from '../model/worker-client';

/** Plain words for the "choosing a backend" and "warming up" phases: both are the phone getting the model ready, not a download. */
export const PREPARING_TEXT = 'Preparing the model on this phone…';

/** Whole MB (1 MiB units, as the rest of the app and the welcome count it). */
export function mb(bytes: number): number {
  return Math.round(bytes / 1048576);
}

export interface ModelProgress {
  /** One line for the Listen panel: "Downloading 34 MB of 78 MB" or the preparing text; empty when nothing is loading. */
  text: string;
  /** 0..1 for the bar. */
  fraction: number;
}

/**
 * What the Listen panel says under its progress bar (DECISIONS.md #70). The byte counts come
 * from the worker's progress messages (loaded so far, MODEL_TOTAL_BYTES); the two phases
 * that are not a download get the same plain sentence. Loaded never shows above total.
 */
export function describeModelProgress(s: Pick<ModelStatus, 'state' | 'phase' | 'progress' | 'loadedBytes' | 'totalBytes'>): ModelProgress {
  if (s.state !== 'loading') return { text: '', fraction: s.state === 'ready' ? 1 : 0 };
  const fraction = Math.max(0, Math.min(1, s.progress));
  if (s.phase === 'backend' || s.phase === 'warmup') return { text: PREPARING_TEXT, fraction };
  if (s.totalBytes <= 0) return { text: 'Downloading the bird model…', fraction };
  return { text: `Downloading ${mb(Math.min(s.loadedBytes, s.totalBytes))} MB of ${mb(s.totalBytes)} MB`, fraction };
}
