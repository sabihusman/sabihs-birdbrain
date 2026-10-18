import { SAMPLE_RATE } from '../../model/constants';
import { fitCanvas } from '../dom';

/** Rolling waveform of the last few seconds, drawn as min/max columns. */
export class WaveformView {
  private readonly columnsPerSecond = 100;
  private mins: Float32Array;
  private maxs: Float32Array;
  private head = 0;
  private acc = { min: 1, max: -1, n: 0 };
  private readonly samplesPerColumn = SAMPLE_RATE / this.columnsPerSecond;

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
    this.draw();
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
    const cols = this.mins.length;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const c = (this.head + Math.floor((x / w) * cols)) % cols;
      const top = mid - Math.max(0.5, this.maxs[c] * mid);
      const bottom = mid - Math.min(-0.5, this.mins[c] * mid);
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }
}
