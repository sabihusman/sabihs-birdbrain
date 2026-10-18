import { encodeWav } from './wav';

/**
 * Collects 48 kHz mono chunks from the AudioWorklet stream as 16-bit PCM and
 * turns them into a WAV blob. Capped to keep memory bounded on phones.
 */
export class Recorder {
  private parts: Int16Array[] = [];
  private samples = 0;
  readonly startedAt = Date.now();

  constructor(
    readonly sampleRate: number,
    readonly maxSeconds = 600,
  ) {}

  get seconds(): number {
    return this.samples / this.sampleRate;
  }

  get full(): boolean {
    return this.samples >= this.maxSeconds * this.sampleRate;
  }

  push(chunk: Float32Array): void {
    if (this.full) return;
    const remaining = this.maxSeconds * this.sampleRate - this.samples;
    const n = Math.min(remaining, chunk.length);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.parts.push(pcm);
    this.samples += n;
  }

  /** All samples as float, for analysis. */
  toFloat32(): Float32Array {
    const out = new Float32Array(this.samples);
    let o = 0;
    for (const p of this.parts) {
      for (let i = 0; i < p.length; i++) out[o + i] = p[i] / 32768;
      o += p.length;
    }
    return out;
  }

  toWavBlob(): Blob {
    return new Blob([encodeWav(this.toFloat32(), this.sampleRate)], { type: 'audio/wav' });
  }
}
