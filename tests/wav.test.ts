import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, toMono } from '../src/audio/wav';

describe('WAV', () => {
  it('writes a valid 44-byte header for mono 16-bit PCM', () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 48000);
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(buf.byteLength).toBe(44 + 5 * 2);
    expect(tag(0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 10);
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(96000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(10);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(16384);
    expect(v.getInt16(48, true)).toBe(-16384);
    expect(v.getInt16(50, true)).toBe(32767);
    expect(v.getInt16(52, true)).toBe(-32768);
  });

  it('round-trips samples through encode/decode', () => {
    const x = new Float32Array(1000).map((_, i) => Math.sin(i * 0.1) * 0.8);
    const dec = decodeWav(encodeWav(x, 44100));
    expect(dec.sampleRate).toBe(44100);
    expect(dec.channels.length).toBe(1);
    expect(dec.channels[0].length).toBe(1000);
    expect(dec.durationSec).toBeCloseTo(1000 / 44100, 6);
    for (let i = 0; i < x.length; i += 50) expect(dec.channels[0][i]).toBeCloseTo(x[i], 3);
  });

  it('interleaves stereo and mixes to mono', () => {
    const l = new Float32Array([0.5, 0.5]);
    const r = new Float32Array([-0.5, 0.5]);
    const dec = decodeWav(encodeWav([l, r], 48000));
    expect(dec.channels.length).toBe(2);
    expect(dec.channels[1][0]).toBeCloseTo(-0.5, 3);
    const mono = toMono(dec.channels);
    expect(mono[0]).toBeCloseTo(0, 3);
    expect(mono[1]).toBeCloseTo(0.5, 3);
  });

  it('decodes 32-bit float WAV', () => {
    const frames = 4;
    const buf = new ArrayBuffer(44 + frames * 4);
    const v = new DataView(buf);
    const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF');
    v.setUint32(4, 36 + frames * 4, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 3, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 48000, true);
    v.setUint32(28, 48000 * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 32, true);
    w(36, 'data');
    v.setUint32(40, frames * 4, true);
    [0.25, -0.25, 1, -1].forEach((s, i) => v.setFloat32(44 + i * 4, s, true));
    const dec = decodeWav(buf);
    expect(Array.from(dec.channels[0])).toEqual([0.25, -0.25, 1, -1]);
  });

  it('rejects non-WAV data', () => {
    expect(() => decodeWav(new ArrayBuffer(100))).toThrow();
  });
});
