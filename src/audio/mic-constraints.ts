/**
 * Microphone constraints and what the browser actually applied.
 *
 * We ask for raw audio (no echo cancellation, noise suppression or automatic
 * gain). Browsers treat these as ideal (not required) constraints, so the
 * result is read back with MediaStreamTrack.getSettings(). On iPhone Safari,
 * MDN browser-compat-data (8.1.6) lists echoCancellation as supported and
 * noiseSuppression / autoGainControl as unsupported: those two are not
 * controllable there and are usually absent from getSettings().
 */

/** Structural subset of MediaTrackConstraints / MediaTrackSettings so this module also compiles with the WebWorker lib. */
export interface MicTrackSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
  deviceId?: string;
}

export const MIC_AUDIO_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const satisfies MicTrackSettings;

export const VOICE_PROCESSING_KEYS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;
export type VoiceProcessingKey = (typeof VOICE_PROCESSING_KEYS)[number];

export type VoiceProcessingStatus = 'off' | 'partly-on' | 'on' | 'not-controllable' | 'unknown';

export interface VoiceProcessingReport {
  status: VoiceProcessingStatus;
  /** true = processing applied, false = off, undefined = the browser did not report it. */
  details: Record<VoiceProcessingKey, boolean | undefined>;
  sampleRate: number | undefined;
  channelCount: number | undefined;
  /** Keys the browser did not report (treated as not controllable). */
  unreported: VoiceProcessingKey[];
}

const LABELS: Record<VoiceProcessingKey, string> = {
  echoCancellation: 'echo cancellation',
  noiseSuppression: 'noise suppression',
  autoGainControl: 'automatic gain',
};

/** Classify the settings a track reported after our "all off" request. null = no track yet. */
export function classifyVoiceProcessing(settings: MicTrackSettings | null | undefined): VoiceProcessingReport {
  const details = {} as Record<VoiceProcessingKey, boolean | undefined>;
  const unreported: VoiceProcessingKey[] = [];
  if (!settings) {
    for (const k of VOICE_PROCESSING_KEYS) details[k] = undefined;
    return { status: 'unknown', details, sampleRate: undefined, channelCount: undefined, unreported: [...VOICE_PROCESSING_KEYS] };
  }
  let on = 0;
  let off = 0;
  for (const k of VOICE_PROCESSING_KEYS) {
    const v = settings[k];
    if (typeof v === 'boolean') {
      details[k] = v;
      if (v) on++;
      else off++;
    } else {
      details[k] = undefined;
      unreported.push(k);
    }
  }
  let status: VoiceProcessingStatus;
  if (on + off === 0) status = 'not-controllable';
  else if (on === VOICE_PROCESSING_KEYS.length) status = 'on';
  else if (on > 0) status = 'partly-on';
  else status = 'off';
  return { status, details, sampleRate: settings.sampleRate, channelCount: settings.channelCount, unreported };
}

export function describeVoiceProcessing(r: VoiceProcessingReport): { headline: string; detail: string } {
  const headline =
    r.status === 'off'
      ? 'Voice processing: off'
      : r.status === 'partly-on'
        ? 'Voice processing: partly on'
        : r.status === 'on'
          ? 'Voice processing: on'
          : r.status === 'not-controllable'
            ? 'Voice processing: not controllable'
            : 'Voice processing: unknown (start listening to find out)';
  const parts: string[] = [];
  for (const k of VOICE_PROCESSING_KEYS) {
    const v = r.details[k];
    parts.push(`${LABELS[k]}: ${v === undefined ? 'not reported' : v ? 'on' : 'off'}`);
  }
  if (r.sampleRate) parts.push(`${r.sampleRate} Hz`);
  const note =
    r.status === 'not-controllable'
      ? ' The browser ignores these settings; on iPhone, noise suppression and automatic gain cannot be switched off from a web page.'
      : r.unreported.length && r.status !== 'unknown'
        ? ` ${r.unreported.map((k) => LABELS[k]).join(' and ')} not controllable on this browser.`
        : '';
  return { headline, detail: parts.join(' · ') + note };
}
