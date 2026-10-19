import { SAMPLE_RATE } from '../model/constants';

/** Imported clips are analysed on-device and capped to keep memory and time bounded. */
export const MAX_IMPORT_SECONDS = 60;

export interface CappedAudio {
  audio: Float32Array;
  truncated: boolean;
  originalSeconds: number;
}

export function capImportedAudio(audio: Float32Array, maxSeconds = MAX_IMPORT_SECONDS, sampleRate = SAMPLE_RATE): CappedAudio {
  const max = Math.round(maxSeconds * sampleRate);
  const originalSeconds = audio.length / sampleRate;
  if (audio.length <= max) return { audio, truncated: false, originalSeconds };
  return { audio: audio.slice(0, max), truncated: true, originalSeconds };
}
