export type RecordingSource = 'mic' | 'import' | 'autoclip';

export interface SpeciesSummary {
  label: string;
  scientific: string;
  common: string;
  maxConfidence: number;
  count: number;
}

export interface RecordingRecord {
  id: string;
  createdAt: number;
  name: string;
  durationSec: number;
  sampleRate: number;
  bytes: number;
  blob: Blob;
  source: RecordingSource;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  /** Species seen in the most recent analysis of this recording. */
  summary: SpeciesSummary[];
  analyzedAt: number | null;
}

export type DetectionSource = 'live' | 'recording' | 'import';

export interface DetectionRecord {
  id: string;
  /** Epoch milliseconds of the start of the analysed window. */
  time: number;
  label: string;
  scientific: string;
  common: string;
  confidence: number;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  recordingId: string | null;
  /** Window start inside the recording, seconds. */
  offsetSec: number | null;
  source: DetectionSource;
  sessionId: string;
}

export interface WikiCacheEntry {
  key: string;
  fetchedAt: number;
  data: unknown;
}

/**
 * One saved clip per species (member feature). Raw, unfiltered 16-bit WAV at
 * 48 kHz, at most 10 s, centred on the detection window(s). Replaced only by a
 * clip with a higher confidence. Kept on the device; never uploaded.
 */
export interface ClipRecord {
  /** Scientific name; one clip per species. */
  scientific: string;
  common: string;
  blob: Blob;
  sampleRate: number;
  durationSec: number;
  confidence: number;
  /** Epoch ms of the detection the clip is centred on. */
  time: number;
  savedAt: number;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  source: DetectionSource;
  recordingId: string | null;
}

