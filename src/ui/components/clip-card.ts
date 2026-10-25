import { decodeWav, toMono } from '../../audio/wav';
import type { Species } from '../../model/labels';
import { SAMPLE_RATE, WINDOW_SAMPLES, WINDOW_SECONDS } from '../../model/constants';
import type { OcclusionResolution } from '../../app/settings';
import { OCCLUSION_GRIDS } from '../../model/occlusion';
import { chosenButtonText, planWhy, whyPlanNote } from '../why-plan';
import { cursorSec, describeWindows, outlineSpans, seekSecAt, WINDOW_MEANING } from '../../species/clip-layout';
import { clipWindows, whyWindowFor } from '../../species/clips';
import { speciesColor } from '../../species/colors';
import type { ClipRecord } from '../../storage/types';
import type { ViewContext } from '../app';
import { el, fmtDuration, pct } from '../dom';
import { SpectrogramView } from '../viz/spectrogram';
import { clipPlayer } from './clip-player';

/**
 * The ID card's clip block: play button, a spectrogram of the clip drawn from
 * the stored audio with the identifying 3 s window(s) outlined and labelled
 * with their confidence, a playback cursor (tap to seek), and a tap-to-run
 * "Why this ID" occlusion heat map on the most confident window. The
 * occlusion is 25–97 model passes, so it never runs on its own.
 */
export function clipCard(ctx: ViewContext, species: Species, clip: ClipRecord): { el: HTMLElement; dispose: () => void } {
  const { controller } = ctx;
  const player = clipPlayer(clip);
  const canvas = el('canvas', { class: 'clip-spectrogram', 'data-testid': 'clip-spectrogram', 'aria-label': `Spectrogram of the saved ${clip.common} clip` });
  const overlay = el('canvas', { class: 'overlay' });
  const box = el('div', { class: 'viz', role: 'button', tabindex: '0', 'aria-label': 'Clip spectrogram: tap to seek, Enter to play or pause' }, canvas, overlay);
  const windowsLine = el('p', { class: 'small muted clip-windows', 'data-testid': 'clip-windows' }, describeWindows(clipWindows(clip)));
  const whyBox = el('div', { class: 'stack', 'data-testid': 'clip-why' });
  const meaning = el('p', { class: 'small clip-meaning', 'data-testid': 'clip-meaning' }, WINDOW_MEANING);
  const root = el('div', { class: 'clip-card', 'data-testid': 'clip-card' }, player.el, box, el('div', { class: 'viz-label' }, 'Outlined: the 3 s windows that identified it, with their confidence.'), windowsLine, whyBox, meaning);

  const spectrogram = new SpectrogramView(canvas, overlay, Math.max(WINDOW_SECONDS, clip.durationSec), 160);
  const color = speciesColor(species.scientific);
  const audio = player.audio;
  let samples: Float32Array | null = null;
  let raf = 0;
  let cancelWhy: (() => void) | null = null;
  let disposed = false;

  const drawFrame = () => {
    spectrogram.setCursor(cursorSec(audio.paused, audio.currentTime, clip.durationSec));
    spectrogram.draw();
  };
  const loop = () => {
    drawFrame();
    raf = audio.paused ? 0 : requestAnimationFrame(loop);
  };
  const startLoop = () => {
    if (!raf) raf = requestAnimationFrame(loop);
  };
  audio.addEventListener('play', startLoop);
  audio.addEventListener('pause', drawFrame);
  audio.addEventListener('ended', drawFrame);
  audio.addEventListener('seeked', drawFrame);

  const seek = (clientX: number) => {
    const rect = overlay.getBoundingClientRect();
    audio.currentTime = seekSecAt(clientX - rect.left, rect.width, clip.durationSec);
    drawFrame();
  };
  overlay.addEventListener('click', (e) => seek(e.clientX));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (audio.paused) void audio.play().catch(() => undefined);
      else audio.pause();
    }
  });

  const why = whyWindowFor(clip);
  const whyBtn = el('button', { class: 'btn small', type: 'button', 'data-testid': 'clip-why-run' }, `Why this ID? (${why.known ? `window at ${fmtDuration(why.offsetSec)}` : 'clip centre'})`);
  /** Coarse on a phone without WebGL, with the chosen level as a second button (DECISIONS.md #85). */
  const currentPlan = () => planWhy(controller.settings.get().occlusionResolution, controller.inference.getStatus().backend, controller.inference.perPassMs);
  const chosenBtn = el('button', { class: 'btn small', type: 'button', 'data-testid': 'clip-why-run-chosen' }, '');
  const renderWhy = () => {
    const plan = currentPlan();
    chosenBtn.textContent = chosenButtonText(plan);
    whyBox.replaceChildren(
      el('div', { class: 'row' }, whyBtn, plan.reduced ? chosenBtn : null),
      el('div', { class: 'small muted', 'data-testid': 'clip-why-note' }, `Mutes parts of the ${why.known ? 'best window' : 'middle 3 s (windows not recorded)'} (${whyPlanNote(plan)}) to show what the ID depends on. Runs only when you tap.`),
    );
  };
  whyBtn.addEventListener('click', () => void runWhy(currentPlan().resolution));
  chosenBtn.addEventListener('click', () => void runWhy(currentPlan().chosen));

  const runWhy = async (resolution: OcclusionResolution) => {
    if (!samples) return;
    if (controller.inference.getStatus().state !== 'ready') {
      ctx.notify({ kind: 'warn', text: 'The model is still loading.' });
      return;
    }
    const grid = OCCLUSION_GRIDS[resolution];
    const start = Math.round(why.offsetSec * SAMPLE_RATE);
    const window = new Float32Array(WINDOW_SAMPLES);
    window.set(samples.subarray(start, Math.min(samples.length, start + WINDOW_SAMPLES)));
    const bar = el('div', { class: 'progress' }, el('span', { style: 'width:0%' }));
    const text = el('div', { class: 'small muted' }, `Running ${grid.timeSteps * grid.freqBands + 1} model passes…`);
    const cancel = el('button', { class: 'btn small', type: 'button' }, 'Cancel');
    whyBox.replaceChildren(text, bar, cancel);
    // The stored clip is raw; only the copy sent to the model gets the low-cut (DECISIONS.md #25).
    const job = controller.inference.occlusion(await controller.prepareForAnalysis(window), species.index, grid.timeSteps, grid.freqBands, (done, total) => {
      (bar.firstElementChild as HTMLElement).style.width = `${Math.round((done / total) * 100)}%`;
      text.textContent = `Model pass ${done} of ${total}…`;
    });
    cancel.addEventListener('click', job.cancel);
    cancelWhy = job.cancel;
    try {
      const res = await job.done;
      cancelWhy = null;
      if (disposed) return;
      if (res.cancelled) {
        renderWhy();
        return;
      }
      spectrogram.setHeatmap({ map: res.map, timeSteps: res.timeSteps, freqBands: res.freqBands, bandEdgesHz: res.bandEdgesHz, color, startSec: why.offsetSec, endSec: why.offsetSec + WINDOW_SECONDS });
      let maxDrop = 0;
      for (const v of res.map) maxDrop = Math.max(maxDrop, v);
      whyBox.replaceChildren(el('div', { class: 'small', 'data-testid': 'clip-why-result' }, `${pct(res.baseline)} on ${fmtDuration(why.offsetSec)}–${fmtDuration(why.offsetSec + WINDOW_SECONDS)}. Muting the outlined part drops it by ${pct(maxDrop)}. ${res.timeSteps}×${res.freqBands} grid.`), whyBtn);
      drawFrame();
    } catch (e) {
      cancelWhy = null;
      if (disposed) return;
      ctx.notify({ kind: 'error', text: `Occlusion failed: ${(e as Error).message}` });
      renderWhy();
    }
  };

  // Decode the stored WAV (our own 16-bit 48 kHz file; no AudioContext needed) and draw.
  void clip.blob
    .arrayBuffer()
    .then((buf) => {
      if (disposed) return;
      const wav = decodeWav(buf);
      samples = toMono(wav.channels);
      spectrogram.renderStatic(samples);
      const spans = outlineSpans(clip);
      spectrogram.setOutlines((spans ?? []).map((s) => ({ startSec: s.startSec, endSec: s.endSec, color, label: s.label })));
      renderWhy();
      requestAnimationFrame(drawFrame);
    })
    .catch(() => {
      windowsLine.textContent = 'Could not decode the saved clip.';
    });

  return {
    el: root,
    dispose() {
      disposed = true;
      cancelWhy?.();
      if (raf) cancelAnimationFrame(raf);
      player.dispose();
    },
  };
}
