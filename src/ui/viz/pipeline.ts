import type { PipelineStage } from '../../app/controller';
import { disclosure } from '../components/disclosure';
import { el } from '../dom';
import { emptyPipelineState, MIN_LIT_MS, nextPipelineState, PIPELINE_STAGES, stageClass, type PipelineState } from './pipeline-state';

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * "How BirdNET decides": one collapsed section instead of seven step cards.
 *
 * Closed, it shows the chip strip Mic › Resample › Window › Spectrogram › Network ›
 * Location › Result; open, a compact numbered list with the limits note at the end.
 * While the mic is on, the chips and the number badges light up as each stage runs,
 * driven by the controller's existing `stage` events: the running stage takes the
 * accent fill, the ones already done in this 3-second window a soft tint, and the next
 * window clears them. Each change is at least MIN_LIT_MS apart so a fast phone still
 * shows the steps. Only class names change here; the Listen screen is never re-rendered.
 */
export class PipelineView {
  readonly el: HTMLDetailsElement;
  private readonly chips = new Map<PipelineStage, HTMLElement>();
  private readonly badges = new Map<PipelineStage, HTMLElement>();
  private readonly live: HTMLElement;
  private state: PipelineState = emptyPipelineState;
  private queue: PipelineStage[] = [];
  private timer: number | null = null;
  private listening = false;
  private resampling = true;

  constructor(opts: { open?: boolean; onToggle?: (open: boolean) => void } = {}) {
    const strip = el('span', { class: 'chip-strip', 'data-testid': 'pipeline-chips', 'aria-hidden': 'true' });
    const items: HTMLElement[] = [];
    PIPELINE_STAGES.forEach((s, i) => {
      const chip = el('span', { class: 'pchip', dataset: { stage: s.id } }, s.chip);
      this.chips.set(s.id, chip);
      if (i > 0) strip.append(el('span', { class: 'chip-sep' }, '›'));
      strip.append(chip);

      const badge = el('span', { class: 'pnum', dataset: { stage: s.id }, 'aria-hidden': 'true' }, String(i + 1));
      this.badges.set(s.id, badge);
      items.push(el('li', { class: 'pstep', dataset: { stage: s.id } }, badge, el('span', null, el('strong', null, s.title), el('span', { class: 'small muted pstep-text' }, s.text))));
    });

    this.live = el('span', { class: 'pipeline-live', 'data-testid': 'pipeline-live', hidden: true }, '● Listening');
    this.el = disclosure(
      {
        title: 'How BirdNET decides',
        summaryExtra: el('span', { class: 'pipeline-summary' }, this.live, strip),
        className: 'pipeline-fold',
        testId: 'pipeline',
        open: opts.open,
        onToggle: opts.onToggle,
      },
      el('ol', { class: 'pipeline-list', 'data-testid': 'pipeline-list' }, ...items),
      el('p', { class: 'small muted' }, 'BirdNET marks when each species is present in a 3-second window. It does not separate overlapping calls or count individuals. ', el('a', { href: '#/help' }, 'More about limits')),
    );
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
    this.live.hidden = !on;
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

  /** The only DOM write: the class of each chip and each number badge. */
  private paint(): void {
    for (const s of PIPELINE_STAGES) {
      const cls = stageClass(this.state, s.id);
      const bypassed = s.id === 'resample' && !this.resampling ? ' bypassed' : '';
      const chip = this.chips.get(s.id);
      if (chip) chip.className = `pchip${cls ? ` ${cls}` : ''}${bypassed}`;
      const badge = this.badges.get(s.id);
      if (badge) badge.className = `pnum${cls ? ` ${cls}` : ''}${bypassed}`;
    }
  }
}
