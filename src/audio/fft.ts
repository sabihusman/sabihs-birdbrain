/**
 * Minimal iterative radix-2 complex FFT with precomputed twiddle factors.
 * Used both for the on-screen spectrogram and for the model's mel spectrogram
 * front end, so it must be exact and deterministic.
 */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    const half = size / 2;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
  }

  /** In-place forward transform of a complex signal (re, im). */
  forward(re: Float32Array | Float64Array, im: Float32Array | Float64Array): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) throw new Error('FFT buffer length mismatch');
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = i + k;
          const b = a + half;
          const xr = re[b];
          const xi = im[b];
          const tr = xr * wr - xi * wi;
          const ti = xr * wi + xi * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  /** In-place inverse transform, scaled by 1/N so inverse(forward(x)) === x. */
  inverse(re: Float32Array | Float64Array, im: Float32Array | Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    this.forward(re, im);
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] = -im[i] / n;
    }
  }
}

/**
 * Hann window. `periodic` (the TensorFlow default) divides by N instead of
 * N-1, which is what tf.signal.hann_window produces.
 */
export function hannWindow(length: number, periodic = true): Float64Array {
  const w = new Float64Array(length);
  const denom = periodic ? length : Math.max(1, length - 1);
  for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  return w;
}
