import { SAMPLE_RATE } from '../../model/constants';
import { fitCanvas } from '../dom';
import { formatGain, gainForPeak, PeakFollower } from './autoscale';

export interface WaveformColumn {
  /** Pixel rows from the top of the canvas. */
  top: number;
  bottom: number;
}

/**
 * Rolling waveform of the last few seconds, drawn as min/max columns and
 * auto-scaled to the loudest recent sample (gain shown as "×N").
 */
export class WaveformView {
  private readonly columnsPerSecond = 100;
  private mins: Float32Array;
  private maxs: Float32Array;
  private head = 0;
  private acc = { min: 1, max: -1, n: 0 };
  private readonly samplesPerColumn = SAMPLE_RATE / this.columnsPerSecond;
  private readonly peak = new PeakFollower(0.92);
  private gainValue = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    seconds = 3,
  ) {
    const cols = Math.round(this.columnsPerSecond * seconds);
    this.mins = new Float32Array(cols);
    this.maxs = new Float32Array(cols);
  }

  reset(): void {
    this.mins.fill(0);
    this.maxs.fill(0);
    this.head = 0;
    this.acc = { min: 1, max: -1, n: 0 };
    this.peak.reset();
    this.gainValue = 1;
    this.draw();
  }

  /** Gain currently applied to the trace (updated by columns()/draw()). */
  get gain(): number {
    return this.gainValue;
  }

  /** Loudest absolute sample currently in the ring. */
  ringPeak(): number {
    let p = 0;
    for (let i = 0; i < this.mins.length; i++) {
      const a = Math.abs(this.mins[i]);
      const b = Math.abs(this.maxs[i]);
      if (a > p) p = a;
      if (b > p) p = b;
    }
    return p;
  }

  /** Pixel extents of each drawn column for a canvas of `width`×`height`; updates the gain. Pure apart from the peak follower. */
  columns(width: number, height: number): WaveformColumn[] {
    this.gainValue = gainForPeak(this.peak.update(this.ringPeak()));
    const g = this.gainValue;
    const cols = this.mins.length;
    const mid = height / 2;
    const out: WaveformColumn[] = new Array(width);
    for (let x = 0; x < width; x++) {
      const c = (this.head + Math.floor((x / width) * cols)) % cols;
      const top = mid - Math.min(mid, Math.max(0.5, this.maxs[c] * g * mid));
      const bottom = mid - Math.max(-mid, Math.min(-0.5, this.mins[c] * g * mid));
      out[x] = { top, bottom };
    }
    return out;
  }

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      if (v < this.acc.min) this.acc.min = v;
      if (v > this.acc.max) this.acc.max = v;
      if (++this.acc.n >= this.samplesPerColumn) {
        this.mins[this.head] = this.acc.min;
        this.maxs[this.head] = this.acc.max;
        this.head = (this.head + 1) % this.mins.length;
        this.acc = { min: 1, max: -1, n: 0 };
      }
    }
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(this.canvas);
    ctx.fillStyle = style.getPropertyValue('--wave') || '#4caf50';
    const columns = this.columns(w, h);
    for (let x = 0; x < w; x++) {
      const { top, bottom } = columns[x];
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    // Gain badge, top right.
    const label = formatGain(this.gainValue);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = style.getPropertyValue('--muted') || '#5c6b62';
    ctx.fillText(label, w - 4, 3);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
}
