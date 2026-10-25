import { encodeWav } from '../audio/wav';
import { SAMPLE_RATE, WINDOW_SECONDS } from '../model/constants';
import { getClipMeta, putClip } from '../storage/db';
import type { ClipRecord, ClipWindow, DetectionSource } from '../storage/types';

/** Longest clip kept per species, seconds. */
export const CLIP_MAX_SECONDS = 10;

export interface ClipCandidate {
  scientific: string;
  common: string;
  confidence: number;
  /** Epoch ms of the detection window start. */
  time: number;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  /** When the device produced the fix (DECISIONS.md #58); null when there was none. */
  fixTime?: number | null;
  source: DetectionSource;
  recordingId: string | null;
  /** The 3 s windows that identified the species, relative to the clip start (see windowsInClip). */
  windows: ClipWindow[];
}

/**
 * Replace-if-higher rule: a species keeps exactly one clip, and a new one only
 * takes its place when its confidence is strictly higher. Equal confidence
 * keeps the older clip (no churn on repeated identical scores).
 */
export function shouldReplaceClip(existing: Pick<ClipRecord, 'confidence'> | null | undefined, candidate: Pick<ClipCandidate, 'confidence'>): boolean {
  if (!existing) return true;
  return candidate.confidence > existing.confidence;
}

export interface Span {
  start: number;
  end: number;
}

/**
 * Choose the clip range (seconds) centred on the detection window(s), capped
 * at `maxSec` and clipped to the audio that exists (`available`).
 *
 *  - `focus` is the span to centre on: one 3 s window, or the span from the
 *    first to the last window of the species when they fit in `maxSec`.
 *  - If `focus` is longer than `maxSec`, the result is `maxSec` centred on it.
 *  - Near the edges the range shifts to stay inside `available` and keep its
 *    length; it only shrinks when less than `maxSec` of audio exists.
 */
export function clipRange(focus: Span, available: Span, maxSec = CLIP_MAX_SECONDS): Span {
  const availLen = Math.max(0, available.end - available.start);
  const len = Math.min(maxSec, availLen);
  if (len <= 0) return { start: available.start, end: available.start };
  const mid = (focus.start + focus.end) / 2;
  let start = mid - len / 2;
  if (start < available.start) start = available.start;
  if (start + len > available.end) start = available.end - len;
  return { start, end: start + len };
}

/**
 * The item with the highest confidence, or `undefined` for an empty list.
 * (An explicit initial value: `reduce` without one throws on an empty array.)
 */
export function bestByConfidence<T extends { confidence: number }>(items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items.reduce((a, b) => (b.confidence > a.confidence ? b : a), items[0]);
}

/**
 * Focus span for a species in one recording: the span of all its detection
 * windows when that fits in the cap, otherwise the single best window.
 */
export function clipFocus(windows: Array<{ offsetSec: number; confidence: number }>, maxSec = CLIP_MAX_SECONDS): Span {
  if (windows.length === 0) throw new Error('clipFocus: no windows');
  const first = Math.min(...windows.map((w) => w.offsetSec));
  const last = Math.max(...windows.map((w) => w.offsetSec)) + WINDOW_SECONDS;
  if (last - first <= maxSec) return { start: first, end: last };
  const best = bestByConfidence(windows) ?? windows[0];
  return { start: best.offsetSec, end: best.offsetSec + WINDOW_SECONDS };
}

/** A detection window on the same timeline as the clip range (session or recording seconds). */
export interface TimedWindow {
  startSec: number;
  confidence: number;
}

/**
 * The windows that fall inside a clip, as offsets from the clip start. A
 * window that overlaps the clip only partly (cut at an edge) is kept with its
 * true offset, so its outline can be clamped when drawn; a window entirely
 * outside is dropped. Sorted by offset, one entry per start (highest
 * confidence wins when two detections share a window).
 */
export function windowsInClip(windows: readonly TimedWindow[], range: Span, windowSec = WINDOW_SECONDS): ClipWindow[] {
  const byStart = new Map<number, ClipWindow>();
  for (const w of windows) {
    const end = w.startSec + windowSec;
    if (end <= range.start || w.startSec >= range.end) continue;
    const offsetSec = roundMs(w.startSec - range.start);
    const prev = byStart.get(offsetSec);
    if (!prev || w.confidence > prev.confidence) byStart.set(offsetSec, { offsetSec, confidence: w.confidence });
  }
  return Array.from(byStart.values()).sort((a, b) => a.offsetSec - b.offsetSec);
}

/** Round a window offset to whole milliseconds (removes float noise from sample arithmetic). */
function roundMs(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/**
 * The identifying windows of a stored clip, or null when the clip predates
 * DB version 4 and did not record them ("unknown windows").
 */
export function clipWindows(clip: Pick<ClipRecord, 'windows'>): ClipWindow[] | null {
  return Array.isArray(clip.windows) ? clip.windows : null;
}

/**
 * The 3 s window "Why this ID" should run on: the most confident identifying
 * window, or for a clip with unknown windows the centre of the clip (live
 * clips were always centred on their detection window, DECISIONS.md #28).
 */
export function whyWindowFor(clip: Pick<ClipRecord, 'windows' | 'durationSec' | 'confidence'>, windowSec = WINDOW_SECONDS): { offsetSec: number; confidence: number; known: boolean } {
  const windows = clipWindows(clip);
  const best = windows ? bestByConfidence(windows) : undefined;
  if (best) return { offsetSec: Math.max(0, Math.min(best.offsetSec, Math.max(0, clip.durationSec - windowSec))), confidence: best.confidence, known: true };
  return { offsetSec: Math.max(0, (clip.durationSec - windowSec) / 2), confidence: clip.confidence, known: false };
}

/** Cut `range` (seconds, relative to `audio` start) out of a 48 kHz buffer. */
export function sliceClip(audio: Float32Array, range: Span, sampleRate = SAMPLE_RATE): Float32Array {
  const start = Math.max(0, Math.round(range.start * sampleRate));
  const end = Math.min(audio.length, Math.round(range.end * sampleRate));
  return audio.slice(start, Math.max(start, end));
}

/**
 * Store `audio` (raw 48 kHz samples, already cut to the clip range) as the
 * species' clip if the replace-if-higher rule allows it. Returns the saved
 * record, or null when the existing clip stays.
 */
export async function saveClipIfBetter(candidate: ClipCandidate, audio: Float32Array): Promise<ClipRecord | null> {
  if (audio.length === 0) return null;
  const existing = await getClipMeta(candidate.scientific);
  if (!shouldReplaceClip(existing, candidate)) return null;
  const clip: ClipRecord = {
    scientific: candidate.scientific,
    common: candidate.common,
    blob: new Blob([encodeWav(audio, SAMPLE_RATE)], { type: 'audio/wav' }),
    sampleRate: SAMPLE_RATE,
    durationSec: audio.length / SAMPLE_RATE,
    confidence: candidate.confidence,
    time: candidate.time,
    savedAt: Date.now(),
    lat: candidate.lat,
    lon: candidate.lon,
    accuracy: candidate.accuracy,
    fixTime: candidate.fixTime ?? null,
    source: candidate.source,
    recordingId: candidate.recordingId,
    windows: candidate.windows.slice().sort((a, b) => a.offsetSec - b.offsetSec),
  };
  await putClip(clip);
  return clip;
}

