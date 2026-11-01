import type { PipelineStage } from '../../app/controller';
import { disclosure } from '../components/disclosure';
import { el } from '../dom';
import { emptyPipelineState, MIN_LIT_MS, nextPipelineState, PIPELINE_STAGES, stageClass, type PipelineState } from './pipeline-state';

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * "See the sound" (DECISIONS.md #109): one collapsed section on Listen. Closed, it shows the chip strip
 * Mic › Resample › Window › Spectrogram › Network › Location › Result; open, the live views (`lead`)
 * with their captions behind an ⓘ button, so all four fit on a phone. The 1–7 explanation of the steps
 * lives on the help page (`PIPELINE_STAGES`, rendered there).
 * While the mic is on, the chips and the number badges light up as each stage runs,
 * driven by the controller's existing `stage` events: the running stage takes the
 * accent fill, the ones already done in this 3-second window a soft tint, and the next
 * window clears them. Each change is at least MIN_LIT_MS apart so a fast phone still
 * shows the steps. Only class names change here; the Listen screen is never re-rendered.
 */
export class PipelineView {
  readonly el: HTMLDetailsElement;
  private readonly chips = new Map<PipelineStage, HTMLElement>();
  private state: PipelineState = emptyPipelineState;
  private queue: PipelineStage[] = [];
  private timer: number | null = null;
  private listening = false;
  private resampling = true;

  constructor(opts: { open?: boolean; onToggle?: (open: boolean) => void; lead?: Node | null; info?: HTMLElement | null } = {}) {
    const strip = el('span', { class: 'chip-strip', 'data-testid': 'pipeline-chips', 'aria-hidden': 'true' });
    PIPELINE_STAGES.forEach((s, i) => {
      const chip = el('span', { class: 'pchip', dataset: { stage: s.id } }, s.chip);
      this.chips.set(s.id, chip);
      if (i > 0) strip.append(el('span', { class: 'chip-sep' }, '›'));
      strip.append(chip);
    });

    this.el = disclosure(
      {
        title: 'See the sound',
        summaryExtra: el('span', { class: 'pipeline-summary' }, strip),
        className: 'pipeline-fold',
        testId: 'pipeline',
        open: opts.open,
        onToggle: opts.onToggle,
      },
      // The ⓘ for the captions sits on the title row (positioned there by CSS) but lives in the body,
      // so tapping it never opens or closes the section.
      opts.info ?? null,
      opts.lead ?? null,
    );
    // No "● Listening" of its own: the header already says so, and it collided with the ⓘ (DECISIONS.md #109).
    this.paint();
  }

  /** One pipeline stage ran. Ignored when the mic is off, so a stopped screen stays plain. */
  pulse(stage: PipelineStage): void {
    if (!this.listening) return;
    if (prefersReducedMotion()) {
      // No stepping: only the finished window lights its result.
      if (stage !== 'result') return;
      this.state = nextPipelineState(this.state, stage, { now: this.now(), reduceMotion: true });
      this.paint();
      return;
    }
    const last = this.queue.length > 0 ? this.queue[this.queue.length - 1] : this.state.active;
    if (last === stage) return; // a repeated stage (the mic fires per audio chunk) changes nothing
    this.queue.push(stage);
    this.drain();
  }

  /** Mic on or off. Switching off clears every chip. */
  setListening(on: boolean): void {
    if (this.listening === on) return;
    this.listening = on;
    if (!on) {
      this.queue = [];
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.state = emptyPipelineState;
    }
    this.paint();
  }

  /** The Resample stage is skipped when the device already records at 48 kHz. */
  setResampling(active: boolean): void {
    this.resampling = active;
    this.paint();
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private drain(): void {
    if (this.timer !== null) return;
    const stage = this.queue.shift();
    if (stage === undefined) return;
    this.state = nextPipelineState(this.state, stage, { now: this.now() });
    this.paint();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.queue.length > 0) this.drain();
    }, MIN_LIT_MS);
  }

  /** The only DOM write: the class of each chip. */
  private paint(): void {
    for (const s of PIPELINE_STAGES) {
      const cls = stageClass(this.state, s.id);
      const bypassed = s.id === 'resample' && !this.resampling ? ' bypassed' : '';
      const chip = this.chips.get(s.id);
      if (chip) chip.className = `pchip${cls ? ` ${cls}` : ''}${bypassed}`;
    }
  }
}
