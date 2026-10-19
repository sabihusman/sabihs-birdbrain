import { DEFAULT_SETTINGS } from '../../app/settings';
import type { Species } from '../../model/labels';
import { speciesColor } from '../../species/colors';
import { fitCanvas } from '../dom';

export interface TimelinePoint {
  sec: number;
  /** species index -> probability */
  probs: Map<number, number>;
}

/** Per-species confidence over recent analysis windows: one coloured line per species. */
export class TimelineView {
  private points: TimelinePoint[] = [];
  private threshold = DEFAULT_SETTINGS.threshold;

  constructor(
    private canvas: HTMLCanvasElement,
    private legend: HTMLElement,
    private speciesList: () => Species[],
    private maxPoints = 60,
  ) {}

  reset(): void {
    this.points = [];
    this.draw();
  }

  setThreshold(t: number): void {
    this.threshold = t;
  }

  setPoints(points: TimelinePoint[]): void {
    this.points = points.slice(-this.maxPoints);
  }

  push(p: TimelinePoint): void {
    this.points.push(p);
    if (this.points.length > this.maxPoints) this.points.shift();
  }

  /** Species worth drawing: highest peak across the visible points, at most 6. */
  private tracked(): number[] {
    const peak = new Map<number, number>();
    for (const p of this.points) for (const [i, v] of p.probs) peak.set(i, Math.max(peak.get(i) ?? 0, v));
    return Array.from(peak.entries())
      .filter(([, v]) => v >= Math.min(this.threshold, 0.1))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([i]) => i);
  }

  draw(): void {
    const ctx = fitCanvas(this.canvas);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const species = this.speciesList();
    const tracked = this.tracked();
    const pad = { l: 28, r: 6, t: 6, b: 4 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;
    const css = getComputedStyle(this.canvas);
    const axis = css.getPropertyValue('--muted') || '#888';
    ctx.strokeStyle = axis;
    ctx.fillStyle = axis;
    ctx.font = '10px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (const v of [0, 0.5, 1]) {
      const y = pad.t + (1 - v) * plotH;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(`${Math.round(v * 100)}%`, 2, y + 3);
    }
    // threshold line
    const ty = pad.t + (1 - this.threshold) * plotH;
    ctx.setLineDash([3, 3]);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(pad.l, ty);
    ctx.lineTo(w - pad.r, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const n = this.points.length;
    if (n >= 1) {
      const minSec = this.points[0].sec;
      const maxSec = Math.max(this.points[n - 1].sec, minSec + 1);
      const xFor = (sec: number) => pad.l + ((sec - minSec) / (maxSec - minSec)) * plotW;
      for (const idx of tracked) {
        const color = speciesColor(species[idx]?.scientific ?? String(idx));
        ctx.strokeStyle = color.css;
        ctx.fillStyle = color.css;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (const p of this.points) {
          const v = p.probs.get(idx) ?? 0;
          const x = xFor(p.sec);
          const y = pad.t + (1 - v) * plotH;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        const last = this.points[n - 1];
        const v = last.probs.get(idx) ?? 0;
        ctx.beginPath();
        ctx.arc(xFor(last.sec), pad.t + (1 - v) * plotH, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Legend always names the species next to its colour.
    this.legend.replaceChildren(
      ...tracked.map((idx) => {
        const sp = species[idx];
        const color = speciesColor(sp?.scientific ?? String(idx));
        const item = document.createElement('span');
        item.className = 'legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = color.css;
        item.append(swatch, document.createTextNode(sp?.common ?? `#${idx}`));
        return item;
      }),
    );
  }
}
