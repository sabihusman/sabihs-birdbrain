import { newId } from '../storage/db';
import type { DetectionRecord, SightingRecord } from '../storage/types';
import { LUMP_GAP_SECONDS } from './recent';

/**
 * Seconds without a species after which its next detection starts a new
 * sighting. One rule for the whole app: the same 30 s rolling gap that lumps
 * hits on the Listen screen (src/species/recent.ts), so stored sightings and
 * what Listen shows agree. Stored per-window hits stay individual.
 */
export const DEFAULT_SIGHTING_GAP_SECONDS = LUMP_GAP_SECONDS;

/**
 * Sightings merge only within one stream of audio: live listening is one
 * stream (across sessions, by time); each recording or import is its own.
 */
export function sightingStreamKey(d: Pick<DetectionRecord, 'scientific' | 'source' | 'sessionId'>): string {
  return `${d.scientific}\u0000${d.source === 'live' ? 'live' : d.sessionId}`;
}

/** Could this detection extend the sighting (same species and stream, within the gap)? */
export function canMerge(s: SightingRecord, d: DetectionRecord, gapMs: number): boolean {
  return sightingStreamKey(s) === sightingStreamKey(d) && d.time <= s.lastTime + gapMs && d.time >= s.firstTime - gapMs;
}

export function sightingFromDetection(d: DetectionRecord, id = newId()): SightingRecord {
  return {
    id,
    label: d.label,
    scientific: d.scientific,
    common: d.common,
    firstTime: d.time,
    lastTime: d.time,
    peakConfidence: d.confidence,
    hits: 1,
    lat: d.lat,
    lon: d.lon,
    accuracy: d.accuracy,
    fixTime: d.fixTime ?? null,
    recordingId: d.recordingId,
    offsetSec: d.offsetSec,
    source: d.source,
    sessionId: d.sessionId,
    peakDetectionId: d.id,
    ...(d.soundOnly ? { soundOnly: true } : {}),
  };
}

/** Fold a detection into a sighting (mutates and returns it). */
export function applyDetection(s: SightingRecord, d: DetectionRecord): SightingRecord {
  s.firstTime = Math.min(s.firstTime, d.time);
  s.lastTime = Math.max(s.lastTime, d.time);
  s.hits += 1;
  if (d.soundOnly) s.soundOnly = true;
  const located = d.lat != null && d.lon != null;
  if (d.confidence > s.peakConfidence) {
    s.peakConfidence = d.confidence;
    s.peakDetectionId = d.id;
    s.recordingId = d.recordingId;
    s.offsetSec = d.offsetSec;
    if (located || s.lat == null) {
      s.lat = d.lat;
      s.lon = d.lon;
      s.accuracy = d.accuracy;
      s.fixTime = d.fixTime ?? null;
    }
  } else if (s.lat == null && located) {
    s.lat = d.lat;
    s.lon = d.lon;
    s.accuracy = d.accuracy;
    s.fixTime = d.fixTime ?? null;
  }
  return s;
}

export interface SightingBuild {
  sightings: SightingRecord[];
  /** detection id → sighting id */
  assignments: Map<string, string>;
}

/**
 * Group detections into sightings from scratch (used by the one-time
 * migration and by tests). Detections are processed in time order; within a
 * stream a detection joins the most recent sighting when it falls inside the
 * gap, otherwise it opens a new one.
 */
export function buildSightings(detections: readonly DetectionRecord[], gapMs: number, makeId: () => string = newId): SightingBuild {
  const sorted = detections.slice().sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  const open = new Map<string, SightingRecord>();
  const sightings: SightingRecord[] = [];
  const assignments = new Map<string, string>();
  for (const d of sorted) {
    const key = sightingStreamKey(d);
    let s = open.get(key);
    if (s && canMerge(s, d, gapMs)) applyDetection(s, d);
    else {
      s = sightingFromDetection(d, makeId());
      sightings.push(s);
      open.set(key, s);
    }
    assignments.set(d.id, s.id);
  }
  return { sightings, assignments };
}
