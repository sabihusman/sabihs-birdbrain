/**
 * When an auto-saved detection window ("Detection window: <bird>" in Recordings) is kept (DECISIONS.md #96).
 * A bird that keeps calling used to get a new clip every 30 s; now a new clip is saved only when it is more
 * confident than that bird's last clip this session, and still not within 30 s of it (overlapping windows of
 * the same call would otherwise each count as "better").
 */
export const AUTO_CLIP_MIN_GAP_MS = 30_000;

export interface LastAutoClip {
  time: number;
  confidence: number;
}

export function shouldAutoSaveClip(last: LastAutoClip | undefined, confidence: number, minConfidence: number, now: number): boolean {
  if (confidence < minConfidence) return false;
  if (!last) return true;
  return confidence > last.confidence && now - last.time >= AUTO_CLIP_MIN_GAP_MS;
}
