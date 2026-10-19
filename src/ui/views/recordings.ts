import { WINDOW_SAMPLES, WINDOW_SECONDS, SAMPLE_RATE } from '../../model/constants';
import { OCCLUSION_GRIDS } from '../../model/occlusion';
import { selectDetections, type Score } from '../../model/postprocess';
import { speciesColor } from '../../species/colors';
import { deleteDetectionsForRecording, deleteRecording, getRecording, listDetectionsForRecording, listRecordings, newId, putRecording, recordDetections } from '../../storage/db';
import type { DetectionRecord, RecordingRecord } from '../../storage/types';
import { downloadBlob } from '../../export/download';
import type { View, ViewContext } from '../app';
import { speciesChip } from '../components/species-chip';
import { el, fmtDateTime, fmtDuration, pct } from '../dom';
import { hrefFor } from '../router';
import { SpectrogramView } from '../viz/spectrogram';
import { TimelineView, type TimelinePoint } from '../viz/timeline';
import { formatBytes } from '../../storage/quota';
import { capImportedAudio, MAX_IMPORT_SECONDS } from '../../audio/import-cap';
import { locationBlock } from '../components/location-block';
import { bestByConfidence, clipFocus, clipRange, sliceClip, windowsInClip } from '../../species/clips';

export function recordingsView(ctx: ViewContext): View {
  const { controller } = ctx;
  const list = el('div', { class: 'list', 'data-testid': 'recordings-list' });
  const fileInput = el('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', class: 'sr-only', id: 'import-file' });
  const importBtn = el('label', { class: 'btn', for: 'import-file' }, 'Import audio file');
  const hint = el('p', { class: 'small muted' }, `Recordings are 16-bit WAV at 48 kHz, stored in this browser only. Imported files are analysed on-device and capped at ${MAX_IMPORT_SECONDS} seconds.`);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    importBtn.textContent = 'Decoding…';
    try {
      const decoded = await controller.decodeAudioFile(await file.arrayBuffer());
      const capped = capImportedAudio(decoded);
      if (capped.truncated) ctx.notify({ kind: 'warn', text: `Imported clips are capped at ${MAX_IMPORT_SECONDS} seconds; the first ${MAX_IMPORT_SECONDS} s of this ${Math.round(capped.originalSeconds)} s file were kept.` });
      const rec = await controller.saveRecording(capped.audio, file.name.replace(/\.[^.]+$/, ''), 'import');
      location.hash = hrefFor({ name: 'recording', id: rec.id });
    } catch (e) {
      ctx.notify({ kind: 'error', text: `Could not import: ${(e as Error).message}` });
    } finally {
      importBtn.textContent = 'Import audio file';
      fileInput.value = '';
    }
  });

  const render = async () => {
    const recs = await listRecordings().catch(() => []);
    list.replaceChildren();
    if (recs.length === 0) {
      list.appendChild(el('p', { class: 'muted' }, 'No recordings yet. Tap Record while listening, or import a file.'));
      return;
    }
    for (const r of recs) {
      const chips = r.summary.slice(0, 3).map((s) => {
        const sp = controller.speciesByScientific(s.scientific);
        return sp ? speciesChip(sp, { confidence: s.maxConfidence, link: false }) : null;
      });
      list.appendChild(el('a', { class: 'list-item', href: hrefFor({ name: 'recording', id: r.id }) }, el('div', { class: 'title' }, r.name), el('div', { class: 'small muted' }, `${fmtDateTime(r.createdAt)} · ${fmtDuration(r.durationSec)} · ${formatBytes(r.bytes)} · ${r.source}`), el('div', { class: 'chip-list', style: 'margin-top:6px' }, ...chips)));
    }
  };
  void render();
  const unsub = controller.on('recording-saved', () => void render());

  const root = el('div', null, el('section', { class: 'card' }, el('div', { class: 'row' }, importBtn, fileInput), hint), list);
  return { el: root, dispose: unsub };
}

export function recordingDetailView(ctx: ViewContext, id: string): View {
  const { controller } = ctx;
  const root = el('div', null, el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Loading recording…')));
  const disposers: Array<() => void> = [];
  let cancelCurrent: (() => void) | null = null;

  void (async () => {
    const rec = await getRecording(id).catch(() => undefined);
    if (!rec) {
      root.replaceChildren(el('section', { class: 'card' }, 'Recording not found.'));
      return;
    }
    const audioUrl = URL.createObjectURL(rec.blob);
    disposers.push(() => URL.revokeObjectURL(audioUrl));
    const player = el('audio', { controls: true, src: audioUrl, style: 'width:100%' });
    const analyzeBtn = el('button', { class: 'btn primary', 'data-testid': 'reanalyze' }, rec.analyzedAt ? 'Re-analyse' : 'Analyse');
    const cancelBtn = el('button', { class: 'btn', style: 'display:none' }, 'Cancel');
    const exportBtn = el('button', { class: 'btn' }, 'Export WAV');
    const deleteBtn = el('button', { class: 'btn danger' }, 'Delete');
    const progress = el('div', { class: 'progress', style: 'display:none' }, el('span', { style: 'width:0%' }));
    const progressText = el('div', { class: 'small muted' }, '');
    const specCanvas = el('canvas', { style: 'height:200px', 'aria-label': 'Spectrogram of the recording' });
    const specOverlay = el('canvas', { class: 'overlay' });
    const specBox = el('div', { class: 'viz' }, specCanvas, specOverlay);
    const timelineCanvas = el('canvas', { class: 'timeline' });
    const legend = el('div', { class: 'legend' });
    const detectionsBox = el('div', { class: 'stack', 'data-testid': 'recording-detections' });
    const whyBox = el('div', { class: 'stack' });
    const spectrogram = new SpectrogramView(specCanvas, specOverlay, 10, 256);
    const timeline = new TimelineView(timelineCanvas, legend, () => controller.species, 400);
    timeline.setThreshold(controller.settings.get().threshold);

    root.replaceChildren(
      el('section', { class: 'card' }, el('h2', null, rec.name), el('div', { class: 'small muted' }, `${fmtDateTime(rec.createdAt)} · ${fmtDuration(rec.durationSec)} · ${formatBytes(rec.bytes)}${rec.lat != null ? ` · ${rec.lat.toFixed(4)}, ${rec.lon?.toFixed(4)}` : ''}`), player, el('div', { class: 'row' }, analyzeBtn, cancelBtn, exportBtn, deleteBtn), progress, progressText, rec.lat != null && rec.lon != null ? locationBlock(rec.lat, rec.lon, { accuracy: rec.accuracy }) : null),
      el('section', { class: 'card' }, el('h2', null, 'Spectrogram'), specBox, el('div', { class: 'viz-label' }, 'Our own FFT, an approximation of what the model sees. Colour strips mark species per analysed window. Tap to seek.'), timelineCanvas, legend),
      el('section', { class: 'card' }, el('h2', null, 'Detections'), detectionsBox),
      el('section', { class: 'card' }, el('h2', null, 'Why this ID'), el('p', { class: 'small muted' }, 'Occlusion analysis: silence parts of the spectrogram, re-run the model and see which parts the confidence depends on.'), whyBox),
    );

    // Decode once for analysis and drawing.
    const audio = await controller.decodeAudioFile(await rec.blob.arrayBuffer());
    spectrogram.renderStatic(audio);
    const duration = audio.length / SAMPLE_RATE;

    let raf = 0;
    const loop = () => {
      spectrogram.setCursor(player.paused && player.currentTime === 0 ? null : player.currentTime);
      spectrogram.draw();
      timeline.draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    disposers.push(() => cancelAnimationFrame(raf));
    specOverlay.style.pointerEvents = 'auto';
    specOverlay.addEventListener('click', (e) => {
      const rect = specOverlay.getBoundingClientRect();
      player.currentTime = Math.max(0, Math.min(duration, spectrogram.secAt(e.clientX - rect.left, rect.width)));
    });

    // Per-window results (from storage or a fresh analysis).
    interface WinRes {
      offsetSec: number;
      scores: Score[];
    }
    let windows: WinRes[] = [];

    const renderDetections = () => {
      const s = controller.settings.get();
      detectionsBox.replaceChildren();
      spectrogram.setHeatmap(null);
      const perSpecies = new Map<number, { best: number; bestOffset: number; count: number }>();
      for (const w of windows) {
        const dets = selectDetections(w.scores, controller.species, { threshold: s.threshold, applyGeo: false, includeNonBird: s.includeNonBird });
        for (const d of dets) {
          const cur = perSpecies.get(d.index);
          if (!cur || d.prob > cur.best) perSpecies.set(d.index, { best: d.prob, bestOffset: w.offsetSec, count: (cur?.count ?? 0) + 1 });
          else cur.count++;
        }
      }
      if (perSpecies.size === 0) {
        detectionsBox.appendChild(el('p', { class: 'muted' }, windows.length ? 'Nothing above the threshold.' : 'Not analysed yet.'));
        whyBox.replaceChildren(el('p', { class: 'muted' }, 'Analyse the recording first.'));
        return;
      }
      whyBox.replaceChildren();
      for (const [index, info] of Array.from(perSpecies.entries()).sort((a, b) => b[1].best - a[1].best)) {
        const sp = controller.species[index];
        if (!sp) continue;
        const seek = el('button', { class: 'btn small' }, `▶ ${fmtDuration(info.bestOffset)}`);
        seek.addEventListener('click', () => {
          player.currentTime = info.bestOffset;
          void player.play();
        });
        detectionsBox.appendChild(el('div', { class: 'row' }, el('div', { style: 'flex:1' }, speciesChip(sp, { confidence: info.best, subtitle: `${info.count} window${info.count > 1 ? 's' : ''} · best at ${fmtDuration(info.bestOffset)}` })), seek));
        const whyBtn = el('button', { class: 'btn small' }, `Why ${sp.common}?`);
        whyBtn.addEventListener('click', () => void runWhy(index, info.bestOffset, whyBtn));
        whyBox.appendChild(whyBtn);
      }
    };

    const applyWindows = () => {
      timeline.setPoints(windows.map((w): TimelinePoint => ({ sec: w.offsetSec, probs: new Map(w.scores.slice(0, 20).map((x) => [x.index, x.prob])) })));
      renderDetections();
    };

    // Load stored detections to seed the view.
    {
      const stored = await listDetectionsForRecording(id).catch(() => [] as DetectionRecord[]);
      const byOffset = new Map<number, Score[]>();
      for (const d of stored) {
        const sp = controller.speciesByScientific(d.scientific);
        if (!sp || d.offsetSec == null) continue;
        const arr = byOffset.get(d.offsetSec) ?? [];
        arr.push({ index: sp.index, prob: d.confidence, inRange: true });
        byOffset.set(d.offsetSec, arr);
      }
      windows = Array.from(byOffset.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([offsetSec, scores]) => ({ offsetSec, scores }));
      for (const w of windows) {
        const dets = selectDetections(w.scores, controller.species, { threshold: controller.settings.get().threshold, applyGeo: false, includeNonBird: true });
        spectrogram.addMark({ startSec: w.offsetSec, endSec: w.offsetSec + WINDOW_SECONDS, colors: dets.map((d) => speciesColor(controller.species[d.index].scientific)), labels: [] });
      }
      applyWindows();
    }

    const analyze = async () => {
      if (controller.inference.getStatus().state !== 'ready') {
        ctx.notify({ kind: 'warn', text: 'The model is still loading.' });
        return;
      }
      analyzeBtn.disabled = true;
      cancelBtn.style.display = '';
      progress.style.display = '';
      windows = [];
      spectrogram.renderStatic(audio);
      const s = controller.settings.get();
      const hop = Math.round((WINDOW_SECONDS - s.overlapSeconds) * SAMPLE_RATE);
      // The stored clip stays raw; only the copy sent to the model gets the low-cut.
      const job = controller.inference.analyzeFile(await controller.prepareForAnalysis(audio.slice()), hop, (w) => {
        const offsetSec = w.offsetSamples / SAMPLE_RATE;
        windows.push({ offsetSec, scores: w.scores });
        const dets = selectDetections(w.scores, controller.species, { threshold: s.threshold, applyGeo: false, includeNonBird: s.includeNonBird });
        spectrogram.addMark({ startSec: offsetSec, endSec: Math.min(duration, offsetSec + WINDOW_SECONDS), colors: dets.map((d) => speciesColor(controller.species[d.index].scientific)), labels: [] });
        (progress.firstElementChild as HTMLElement).style.width = `${Math.round(((w.index + 1) / w.total) * 100)}%`;
        progressText.textContent = `Window ${w.index + 1} of ${w.total}`;
        applyWindows();
      });
      cancelCurrent = job.cancel;
      const cancelled = await job.done.catch((e: Error) => {
        ctx.notify({ kind: 'error', text: `Analysis failed: ${e.message}` });
        return true;
      });
      cancelCurrent = null;
      cancelBtn.style.display = 'none';
      progress.style.display = 'none';
      progressText.textContent = cancelled ? 'Cancelled.' : `Analysed ${windows.length} windows.`;
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'Re-analyse';
      if (!cancelled) await persist(s.threshold, s.includeNonBird);
    };

    const persist = async (threshold: number, includeNonBird: boolean) => {
      await deleteDetectionsForRecording(id);
      const records: DetectionRecord[] = [];
      const summaryEntries: Array<{ index: number; prob: number }> = [];
      for (const w of windows) {
        for (const d of selectDetections(w.scores, controller.species, { threshold, applyGeo: false, includeNonBird })) {
          const sp = controller.species[d.index];
          summaryEntries.push({ index: d.index, prob: d.prob });
          records.push({ id: newId(), time: rec.createdAt + w.offsetSec * 1000, label: sp.label, scientific: sp.scientific, common: sp.common, confidence: d.prob, lat: rec.lat, lon: rec.lon, accuracy: rec.accuracy, recordingId: id, offsetSec: w.offsetSec, source: rec.source === 'import' ? 'import' : 'recording', sessionId: `rec-${id}` });
        }
      }
      await recordDetections(records, controller.settings.get().sightingGapSeconds * 1000);
      rec.summary = controller.summarize(summaryEntries);
      rec.analyzedAt = Date.now();
      await putRecording(rec);
      controller.emit('detections-changed', undefined);
      await offerClips(records);
    };

    /** One raw clip per detected species, centred on its windows, capped at 10 s (member feature). */
    const offerClips = async (records: DetectionRecord[]) => {
      if (!controller.clipsCollected) return;
      const bySpecies = new Map<string, DetectionRecord[]>();
      for (const r of records) bySpecies.set(r.scientific, [...(bySpecies.get(r.scientific) ?? []), r]);
      for (const dets of bySpecies.values()) {
        const best = bestByConfidence(dets);
        if (!best) continue; // cannot happen (groups are non-empty), but keeps the call total
        const focus = clipFocus(dets.map((d) => ({ offsetSec: d.offsetSec ?? 0, confidence: d.confidence })));
        const range = clipRange(focus, { start: 0, end: audio.length / SAMPLE_RATE });
        const windows = windowsInClip(
          dets.map((d) => ({ startSec: d.offsetSec ?? 0, confidence: d.confidence })),
          range,
        );
        await controller
          .offerClip({ scientific: best.scientific, common: best.common, confidence: best.confidence, time: best.time, lat: best.lat, lon: best.lon, accuracy: best.accuracy, source: best.source, recordingId: id, windows }, sliceClip(audio, range))
          .catch((e: Error) => ctx.notify({ kind: 'warn', text: `Could not save the species clip: ${e.message}` }));
      }
    };

    const runWhy = async (index: number, offsetSec: number, btn: HTMLButtonElement) => {
      if (controller.inference.getStatus().state !== 'ready') return;
      const sp = controller.species[index];
      const grid = OCCLUSION_GRIDS[controller.settings.get().occlusionResolution];
      const start = Math.round(offsetSec * SAMPLE_RATE);
      const window = new Float32Array(WINDOW_SAMPLES);
      window.set(audio.subarray(start, Math.min(audio.length, start + WINDOW_SAMPLES)));
      const bar = el('div', { class: 'progress' }, el('span', { style: 'width:0%' }));
      const text = el('div', { class: 'small muted' }, `Running ${grid.timeSteps * grid.freqBands + 1} model passes…`);
      const cancel = el('button', { class: 'btn small' }, 'Cancel');
      const box = el('div', { class: 'stack' }, text, bar, cancel);
      btn.replaceWith(box);
      const job = controller.inference.occlusion(await controller.prepareForAnalysis(window), index, grid.timeSteps, grid.freqBands, (done, total) => {
        (bar.firstElementChild as HTMLElement).style.width = `${Math.round((done / total) * 100)}%`;
        text.textContent = `Model pass ${done} of ${total}…`;
      });
      cancel.addEventListener('click', job.cancel);
      cancelCurrent = job.cancel;
      try {
        const res = await job.done;
        cancelCurrent = null;
        if (res.cancelled) {
          box.replaceWith(btn);
          return;
        }
        spectrogram.setHeatmap({ map: res.map, timeSteps: res.timeSteps, freqBands: res.freqBands, bandEdgesHz: res.bandEdgesHz, color: speciesColor(sp.scientific), startSec: offsetSec, endSec: offsetSec + WINDOW_SECONDS });
        let maxDrop = 0;
        for (const v of res.map) maxDrop = Math.max(maxDrop, v);
        box.replaceChildren(el('div', { class: 'small' }, `${sp.common}: baseline ${pct(res.baseline)}. Silencing the most important region (shaded) drops it by ${pct(maxDrop)}. Window ${fmtDuration(offsetSec)}–${fmtDuration(offsetSec + WINDOW_SECONDS)}, ${res.timeSteps}×${res.freqBands} grid.`), btn);
        specBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {
        ctx.notify({ kind: 'error', text: `Occlusion failed: ${(e as Error).message}` });
        box.replaceWith(btn);
      }
    };

    analyzeBtn.addEventListener('click', () => void analyze());
    cancelBtn.addEventListener('click', () => cancelCurrent?.());
    exportBtn.addEventListener('click', () => downloadBlob(rec.blob, `${rec.name.replace(/[^\w.-]+/g, '_')}.wav`));
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this recording and its detections?')) return;
      cancelCurrent?.();
      await deleteRecording(id);
      controller.emit('detections-changed', undefined);
      location.hash = hrefFor({ name: 'recordings' });
    });
    disposers.push(controller.settings.on('change', (s) => {
      timeline.setThreshold(s.threshold);
      renderDetections();
    }));
    if (rec.analyzedAt == null && rec.source !== 'autoclip' && controller.inference.getStatus().state === 'ready') void analyze();
  })();

  return {
    el: root,
    dispose() {
      cancelCurrent?.();
      for (const d of disposers) d();
    },
  };
}

export type { RecordingRecord };
