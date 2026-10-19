/**
 * Ring buffer over a sample stream with absolute positions, so a slice of the
 * raw audio can be recovered for a window that was analysed from the filtered
 * stream (both streams share the same sample timeline).
 */
export class SampleRing {
  private readonly data: Float32Array;
  /** Absolute index of the next sample to be written. */
  private writePos = 0;

  constructor(readonly capacity: number) {
    this.data = new Float32Array(capacity);
  }

  get end(): number {
    return this.writePos;
  }

  get start(): number {
    return Math.max(0, this.writePos - this.capacity);
  }

  push(chunk: Float32Array): void {
    if (chunk.length > this.capacity) {
      // Only the last `capacity` samples can survive; skip the rest but keep the timeline.
      const skip = chunk.length - this.capacity;
      this.writePos += skip;
      chunk = chunk.subarray(skip);
    }
    const head = this.writePos % this.capacity;
    const first = Math.min(chunk.length, this.capacity - head);
    this.data.set(chunk.subarray(0, first), head);
    if (first < chunk.length) this.data.set(chunk.subarray(first), 0);
    this.writePos += chunk.length;
  }

  /** Copy [offset, offset + length) if it is still fully inside the ring; otherwise null. */
  slice(offset: number, length: number): Float32Array | null {
    if (length > this.capacity || offset < this.start || offset + length > this.writePos) return null;
    const out = new Float32Array(length);
    const from = offset % this.capacity;
    const first = Math.min(length, this.capacity - from);
    out.set(this.data.subarray(from, from + first));
    if (first < length) out.set(this.data.subarray(0, length - first), first);
    return out;
  }

  reset(): void {
    this.writePos = 0;
  }
}
