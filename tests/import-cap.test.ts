import { describe, expect, it } from 'vitest';
import { capImportedAudio, MAX_IMPORT_SECONDS } from '../src/audio/import-cap';

describe('imported clip cap', () => {
  it('leaves short clips alone', () => {
    const a = new Float32Array(48000 * 10);
    const r = capImportedAudio(a);
    expect(r.truncated).toBe(false);
    expect(r.audio).toBe(a);
    expect(r.originalSeconds).toBe(10);
  });
  it('truncates to 60 seconds', () => {
    const a = new Float32Array(48000 * 90);
    const r = capImportedAudio(a);
    expect(r.truncated).toBe(true);
    expect(r.audio.length).toBe(48000 * MAX_IMPORT_SECONDS);
    expect(r.originalSeconds).toBe(90);
  });
});
