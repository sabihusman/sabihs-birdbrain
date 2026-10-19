import { describe, expect, it } from 'vitest';
import { classifyVoiceProcessing, describeVoiceProcessing, MIC_AUDIO_CONSTRAINTS } from '../src/audio/mic-constraints';

describe('microphone constraints', () => {
  it('requests raw mono audio with all voice processing off', () => {
    expect(MIC_AUDIO_CONSTRAINTS).toEqual({ channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });

  it('reports "off" when the browser applied all three', () => {
    const r = classifyVoiceProcessing({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 });
    expect(r.status).toBe('off');
    expect(r.unreported).toEqual([]);
    expect(describeVoiceProcessing(r).headline).toBe('Voice processing: off');
    expect(describeVoiceProcessing(r).detail).toContain('48000 Hz');
  });

  it('reports "partly on" when any processing stayed on', () => {
    const r = classifyVoiceProcessing({ echoCancellation: false, noiseSuppression: true, autoGainControl: false });
    expect(r.status).toBe('partly-on');
    expect(describeVoiceProcessing(r).detail).toContain('noise suppression: on');
  });

  it('reports "on" when everything stayed on', () => {
    expect(classifyVoiceProcessing({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }).status).toBe('on');
  });

  it('reports "not controllable" when nothing is reported (iPhone-style settings object)', () => {
    const r = classifyVoiceProcessing({ sampleRate: 48000, channelCount: 1, deviceId: 'x' });
    expect(r.status).toBe('not-controllable');
    expect(r.unreported.length).toBe(3);
    expect(describeVoiceProcessing(r).detail).toContain('not reported');
  });

  it('keeps "off" but names the keys Safari does not report', () => {
    const r = classifyVoiceProcessing({ echoCancellation: false, sampleRate: 48000 });
    expect(r.status).toBe('off');
    expect(r.unreported).toEqual(['noiseSuppression', 'autoGainControl']);
    expect(describeVoiceProcessing(r).detail).toMatch(/noise suppression and automatic gain not controllable/);
  });

  it('is "unknown" before any track exists', () => {
    expect(classifyVoiceProcessing(null).status).toBe('unknown');
  });
});
