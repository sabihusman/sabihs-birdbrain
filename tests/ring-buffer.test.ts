import { describe, expect, it } from 'vitest';
import { SampleRing } from '../src/audio/ring-buffer';

describe('SampleRing', () => {
  it('recovers a slice by absolute offset across the wrap point', () => {
    const r = new SampleRing(10);
    r.push(new Float32Array([0, 1, 2, 3, 4, 5, 6]));
    r.push(new Float32Array([7, 8, 9, 10, 11, 12]));
    expect(r.end).toBe(13);
    expect(r.start).toBe(3);
    expect(Array.from(r.slice(8, 4)!)).toEqual([8, 9, 10, 11]);
    expect(Array.from(r.slice(3, 10)!)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('returns null for data that has been overwritten or not yet written', () => {
    const r = new SampleRing(10);
    r.push(new Float32Array(15).map((_, i) => i));
    expect(r.slice(0, 5)).toBeNull();
    expect(r.slice(12, 5)).toBeNull();
    expect(r.slice(5, 11)).toBeNull();
    expect(Array.from(r.slice(5, 10)!)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('handles chunks larger than the capacity', () => {
    const r = new SampleRing(4);
    r.push(new Float32Array([1, 2, 3, 4, 5, 6]));
    expect(Array.from(r.slice(2, 4)!)).toEqual([3, 4, 5, 6]);
  });
});
