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
