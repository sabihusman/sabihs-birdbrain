import { FFT, hannWindow } from '../../audio/fft';
import { stft } from '../../audio/stft';
import { SAMPLE_RATE } from '../../model/constants';
import type { SpeciesColor } from '../../species/colors';
import { fitCanvas } from '../dom';
import { AdaptiveDbRange, columnDb, maxOf } from './autoscale';
import { INFERNO } from './colormap';

export const SPEC_FFT = 1024;
export const SPEC_MAX_HZ = 15000;
/** A full-scale sine through a Hann window peaks at N/4 in the FFT, so 4/N reads 0 dBFS. */
export const SPEC_MAG_SCALE = 4 / SPEC_FFT;

export interface WindowMark {
  startSec: number;
  endSec: number;
  colors: SpeciesColor[];
  labels: string[];
}

export interface Heatmap {
  map: Float32Array;
  timeSteps: number;
  freqBands: number;
  bandEdgesHz: number[];
  color: SpeciesColor;
  /** Seconds covered by the heatmap (window start/end inside the recording). */
  startSec: number;
  endSec: number;
}

/**
 * Scrolling (live) or static (recording) spectrogram with overlays for the
 * analysis window, analysed-window species shading and occlusion heatmaps.
 * Drawn with our own FFT; it approximates (but is not identical to) the mel
 * spectrograms BirdNET computes internally.
 */
export class SpectrogramView {
  private readonly fft = new FFT(SPEC_FFT);
  private readonly window = hannWindow(SPEC_FFT);
  private readonly hop = 960; // 50 columns per second at 48 kHz
  private pending = new Float32Array(0);
  private image: HTMLCanvasElement;
  private imageCtx: CanvasRenderingContext2D;
  private column: ImageData;
  private readonly maxBin = Math.floor((SPEC_MAX_HZ / SAMPLE_RATE) * SPEC_FFT);
  /** Stream time (seconds) at the right edge of the image. */
  private nowSec = 0;
  private marks: WindowMark[] = [];
  private heatmap: Heatmap | null = null;
  private liveWindow: { startSec: number; endSec: number } | null = null;
  private staticDuration: number | null = null;
  private cursorSec: number | null = null;
  /** Colour range follows the loudest recent bin, so quiet raw mic input is still visible. */
  private readonly range = new AdaptiveDbRange();
  private readonly dbColumn: Float32Array;

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
    private visibleSeconds = 10,
    private readonly imageHeight = 256,
  ) {
    this.image = document.createElement('canvas');
    this.image.width = Math.round(visibleSeconds * (SAMPLE_RATE / this.hop));
    this.image.height = imageHeight;
    this.imageCtx = this.image.getContext('2d', { willReadFrequently: true })!;
    this.imageCtx.fillStyle = '#000004';
    this.imageCtx.fillRect(0, 0, this.image.width, this.image.height);
    this.column = this.imageCtx.createImageData(1, imageHeight);
    this.dbColumn = new Float32Array(imageHeight);
  }

  /** Current colour window in dBFS (for captions and tests). */
  get dbRange(): { topDb: number; bottomDb: number } {
    return { topDb: this.range.topDb, bottomDb: this.range.bottomDb };
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.nowSec = 0;
    this.marks = [];
    this.heatmap = null;
    this.liveWindow = null;
    this.staticDuration = null;
    this.cursorSec = null;
    this.range.reset();
    this.imageCtx.fillStyle = '#000004';
    this.imageCtx.fillRect(0, 0, this.image.width, this.image.height);
    this.draw();
  }

  get currentTime(): number {
    return this.nowSec;
  }

  /** Live mode: append audio and scroll. */
  push(chunk: Float32Array): void {
    const merged = new Float32Array(this.pending.length + chunk.length);
    merged.set(this.pending);
    merged.set(chunk, this.pending.length);
    let offset = 0;
    const re = new Float64Array(SPEC_FFT);
    const im = new Float64Array(SPEC_FFT);
    const cols: Uint8ClampedArray[] = [];
    while (offset + SPEC_FFT <= merged.length) {
      for (let i = 0; i < SPEC_FFT; i++) {
        re[i] = merged[offset + i] * this.window[i];
        im[i] = 0;
      }
      this.fft.forward(re, im);
      cols.push(this.columnPixels(re, im));
      offset += this.hop;
      this.nowSec += this.hop / SAMPLE_RATE;
    }
    this.pending = merged.slice(offset);
    if (cols.length === 0) return;
    const ctx = this.imageCtx;
    ctx.drawImage(this.image, -cols.length, 0);
    for (let c = 0; c < cols.length; c++) {
      this.column.data.set(cols[c]);
      ctx.putImageData(this.column, this.image.width - cols.length + c, 0);
    }
    // Forget marks that have scrolled away.
    const oldest = this.nowSec - this.visibleSeconds - 3;
    this.marks = this.marks.filter((m) => m.endSec > oldest);
  }

  /** Live column: dB per row (row 0 = highest frequency), range adapts to this column's peak. */
  private columnPixels(re: Float64Array, im: Float64Array): Uint8ClampedArray {
    const db = columnDb(re, im, this.imageHeight, this.maxBin, SPEC_MAG_SCALE, this.dbColumn);
    this.range.update(maxOf(db));
    return this.pixelsFromDb(db);
  }

  private pixelsFromDb(db: Float32Array): Uint8ClampedArray {
    const h = this.imageHeight;
    const out = new Uint8ClampedArray(h * 4);
    for (let y = 0; y < h; y++) {
      const idx = this.range.index(db[y]);
      out[y * 4] = INFERNO[idx * 3];
      out[y * 4 + 1] = INFERNO[idx * 3 + 1];
      out[y * 4 + 2] = INFERNO[idx * 3 + 2];
      out[y * 4 + 3] = 255;
    }
    return out;
  }

  /** Static mode: render a whole recording to fit the image width. */
  renderStatic(audio: Float32Array): void {
    this.marks = [];
    this.heatmap = null;
    this.liveWindow = null;
    this.staticDuration = audio.length / SAMPLE_RATE;
    this.nowSec = this.staticDuration;
    const width = this.image.width;
    const hop = Math.max(256, Math.floor(audio.length / width));
    const s = stft(audio, SPEC_FFT, hop, this.window, this.fft);
    const ctx = this.imageCtx;
    ctx.fillStyle = '#000004';
    ctx.fillRect(0, 0, width, this.image.height);
    // Two passes: one fixed colour window for the whole clip, set from its loudest bin.
    const re = new Float64Array(SPEC_FFT);
    const im = new Float64Array(SPEC_FFT);
    const columns: Float32Array[] = [];
    let peakDb = -Infinity;
    for (let f = 0; f < s.frames; f++) {
      const o = f * s.bins;
      for (let k = 0; k < s.bins; k++) {
        re[k] = s.re[o + k];
        im[k] = s.im[o + k];
      }
      const db = columnDb(re, im, this.imageHeight, this.maxBin, SPEC_MAG_SCALE);
      peakDb = Math.max(peakDb, maxOf(db));
      columns.push(db);
    }
    this.range.reset(Math.max(peakDb, -70));
    for (let f = 0; f < columns.length; f++) {
      const x = Math.floor((f / columns.length) * width);
      this.column.data.set(this.pixelsFromDb(columns[f]));
      ctx.putImageData(this.column, x, 0);
    }
    this.draw();
  }

  addMark(mark: WindowMark): void {
    this.marks.push(mark);
  }

  setLiveWindow(startSec: number, endSec: number): void {
    this.liveWindow = { startSec, endSec };
  }

  setHeatmap(h: Heatmap | null): void {
    this.heatmap = h;
    this.draw();
  }

  setCursor(sec: number | null): void {
    this.cursorSec = sec;
  }

  /** Seconds visible from the left edge. */
  private get leftSec(): number {
    return this.staticDuration != null ? 0 : this.nowSec - this.visibleSeconds;
  }

  private get spanSec(): number {
    return this.staticDuration != null ? this.staticDuration : this.visibleSeconds;
  }

  xFor(sec: number, width: number): number {
    return ((sec - this.leftSec) / this.spanSec) * width;
  }

  secAt(x: number, width: number): number {
    return this.leftSec + (x / width) * this.spanSec;
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.image, 0, 0, w, h);

    const octx = fitCanvas(this.overlay);
    octx.clearRect(0, 0, w, h);
    const xFor = (sec: number) => this.xFor(sec, w);
    const yForHz = (hz: number) => h - (Math.min(SPEC_MAX_HZ, hz) / SPEC_MAX_HZ) * h;

    // Heatmap (occlusion) in the species colour, alpha by importance.
    if (this.heatmap) {
      const hm = this.heatmap;
      let max = 0;
      for (let i = 0; i < hm.map.length; i++) max = Math.max(max, hm.map[i]);
      const [r, g, b] = hm.color.rgb;
      for (let t = 0; t < hm.timeSteps; t++) {
        const x0 = xFor(hm.startSec + ((hm.endSec - hm.startSec) * t) / hm.timeSteps);
        const x1 = xFor(hm.startSec + ((hm.endSec - hm.startSec) * (t + 1)) / hm.timeSteps);
        for (let f = 0; f < hm.freqBands; f++) {
          const v = hm.map[t * hm.freqBands + f];
          if (max <= 0 || v <= 0) continue;
          const a = Math.min(0.85, (v / max) * 0.85);
          octx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
          const y1 = yForHz(hm.bandEdgesHz[f]);
          const y0 = yForHz(hm.bandEdgesHz[f + 1]);
          octx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        }
      }
    }

    // Analysed windows: translucent fill plus a stacked colour strip per species at the top.
    for (const m of this.marks) {
      const x0 = xFor(m.startSec);
      const x1 = xFor(m.endSec);
      if (x1 < 0 || x0 > w) continue;
      if (m.colors.length === 0) {
        octx.fillStyle = 'rgba(255,255,255,0.05)';
        octx.fillRect(x0, 0, x1 - x0, h);
        continue;
      }
      const strip = 6;
      m.colors.forEach((c, i) => {
        const [r, g, b] = c.rgb;
        octx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.18)`;
        octx.fillRect(x0, 0, x1 - x0, h);
        octx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.95)`;
        octx.fillRect(x0, i * strip, x1 - x0, strip - 1);
      });
    }

    // Current analysis window outline.
    if (this.liveWindow) {
      const x0 = xFor(this.liveWindow.startSec);
      const x1 = xFor(this.liveWindow.endSec);
      octx.strokeStyle = 'rgba(255,255,255,0.8)';
      octx.lineWidth = 1.5;
      octx.setLineDash([4, 3]);
      octx.strokeRect(x0 + 1, 1, x1 - x0 - 2, h - 2);
      octx.setLineDash([]);
    }

    if (this.cursorSec != null) {
      const x = xFor(this.cursorSec);
      octx.strokeStyle = 'rgba(255,255,255,0.9)';
      octx.lineWidth = 1.5;
      octx.beginPath();
      octx.moveTo(x, 0);
      octx.lineTo(x, h);
      octx.stroke();
    }

    // Frequency labels.
    octx.fillStyle = 'rgba(255,255,255,0.7)';
    octx.font = '10px system-ui, sans-serif';
    for (const khz of [2, 5, 10]) {
      const y = yForHz(khz * 1000);
      octx.fillText(`${khz} kHz`, 3, y - 2);
      octx.fillStyle = 'rgba(255,255,255,0.15)';
      octx.fillRect(0, y, w, 1);
      octx.fillStyle = 'rgba(255,255,255,0.7)';
    }
    // Colour window, bottom right.
    octx.textAlign = 'right';
    octx.fillText(`${Math.round(this.range.bottomDb)} to ${Math.round(this.range.topDb)} dBFS`, w - 3, h - 4);
    octx.textAlign = 'left';
  }
}
