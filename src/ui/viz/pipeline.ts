import type { PipelineStage } from '../../app/controller';
import { el } from '../dom';

const STAGES: Array<{ id: PipelineStage; title: string; text: string }> = [
  { id: 'mic', title: 'Microphone', text: 'Your phone’s mic captures sound. It stays on the device.' },
  { id: 'resample', title: 'Resample', text: 'Audio is converted to mono at 48,000 samples per second, the rate BirdNET expects.' },
  { id: 'window', title: 'Window', text: 'The stream is cut into 3-second pieces that overlap, so a call on a boundary is not missed.' },
  { id: 'spectrogram', title: 'Spectrogram', text: 'Each window becomes two mel spectrograms (0–3 kHz and 0.5–15 kHz): pictures of pitch over time.' },
  { id: 'network', title: 'Neural network', text: 'An EfficientNet-style network scores all 6,522 classes; several can be high at once.' },
  { id: 'filter', title: 'Location & season', text: 'A second model drops species not expected at your location this week.' },
  { id: 'result', title: 'Result', text: 'Everything above your confidence slider is shown, with its confidence.' },
];

/** "How it works" view: each stage lights up as audio moves through it. */
export class PipelineView {
  readonly el: HTMLElement;
  private nodes = new Map<PipelineStage, HTMLElement>();
  private timers = new Map<PipelineStage, number>();

  constructor() {
    this.el = el('ol', { class: 'pipeline', 'aria-label': 'How it works' });
    for (const s of STAGES) {
      const node = el('li', { class: 'stage', dataset: { stage: s.id } }, el('span', { class: 'stage-dot', 'aria-hidden': 'true' }), el('div', null, el('div', { class: 'stage-title' }, s.title), el('div', { class: 'stage-text' }, s.text)));
      this.nodes.set(s.id, node);
      this.el.appendChild(node);
    }
  }

  pulse(stage: PipelineStage): void {
    const node = this.nodes.get(stage);
    if (!node) return;
    node.classList.add('active');
    const prev = this.timers.get(stage);
    if (prev) clearTimeout(prev);
    this.timers.set(
      stage,
      window.setTimeout(() => node.classList.remove('active'), stage === 'mic' ? 250 : 700),
    );
  }

  setResampling(active: boolean): void {
    this.nodes.get('resample')?.classList.toggle('bypassed', !active);
  }
}
