import { describe, expect, it } from 'vitest';
import { magnitude, stft } from '../src/audio/stft';
import { analysisStft, melBandEdges, occludeAudio, regionFor } from '../src/model/occlusion';

describe('occlusion masking', () => {
  it('builds monotonic mel band edges from 0 to fmax', () => {
    const edges = melBandEdges(4, 15000);
    expect(edges.length).toBe(5);
    expect(edges[0]).toBe(0);
    expect(edges[4]).toBe(15000);
    for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeGreaterThan(edges[i - 1]);
    // mel spacing: low bands are narrower than high bands
    expect(edges[1] - edges[0]).toBeLessThan(edges[4] - edges[3]);
  });

  it('removes a tone inside the masked region and keeps one outside it', () => {
    const sr = 48000;
    const n = sr; // 1 s
    const low = 500;
    const high = 8000;
    const audio = new Float32Array(n).map((_, i) => 0.4 * Math.sin((2 * Math.PI * low * i) / sr) + 0.4 * Math.sin((2 * Math.PI * high * i) / sr));
    const s = analysisStft(audio);
    const edges = melBandEdges(4, 15000); // band 0 ends ~ 1.2 kHz, so the 500 Hz tone is in band 0
    const region = regionFor(s, sr, 0, 1, edges, 0);
    const masked = occludeAudio(audio, s, region);
    const mag = magnitude(stft(masked.subarray(2048, 2048 + 16384), 1024, 512));
    const hzPerBin = sr / 1024;
    const binEnergy = (hz: number) => {
      const k = Math.round(hz / hzPerBin);
      let e = 0;
      for (let f = 0; f < mag.length / 513; f++) e += mag[f * 513 + k];
      return e;
    };
    expect(binEnergy(low)).toBeLessThan(binEnergy(high) * 0.02);
    expect(binEnergy(high)).toBeGreaterThan(1);
  });
});
