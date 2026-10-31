import { WINDOW_SAMPLES, WINDOW_SECONDS, SAMPLE_RATE } from '../../model/constants';
import { MODEL_DOWNLOAD_ERROR } from '../../model/model-source';
import type { Species } from '../../model/labels';
import type { OcclusionResolution } from '../../app/settings';
import { OCCLUSION_GRIDS } from '../../model/occlusion';
import { chosenButtonText, estimateText, planWhy, RESOLUTION_NAME, whyPlanNote } from '../why-plan';
import { selectDetections, type Score } from '../../model/postprocess';
import { speciesColor } from '../../species/colors';
import { deleteDetectionsForRecording, deleteRecording, getRecording, listDetectionsForRecording, listRecordings, newId, putRecording, recordDetections } from '../../storage/db';
import type { DetectionRecord, RecordingRecord } from '../../storage/types';
import { downloadBlob } from '../../export/download';
import type { View, ViewContext } from '../app';
import { speciesChip } from '../components/species-chip';
import { closestCandidates, NO_MATCH_TIP, NO_MATCH_TITLE, noMatchLines } from '../../species/no-match';
import { el, fmtDateTime, fmtDuration, pct } from '../dom';
import { whyExplanationText } from '../why-text';
import { hrefFor } from '../router';
import { SpectrogramView } from '../viz/spectrogram';
import { formatBytes } from '../../storage/quota';
import { capImportedAudio, MAX_IMPORT_SECONDS } from '../../audio/import-cap';
import { aboutBird } from '../components/about-bird';
import { askBox } from '../components/ask-box';
import { locationBlock } from '../components/location-block';
import { mapPreview } from '../components/map-preview';
import { bestByConfidence, clipFocus, clipRange, sliceClip, windowsInClip } from '../../species/clips';
import { confidenceLine, windowLines } from '../confidence-text';
import { cssToken } from '../../theme/theme';
import { groupRecordingsByBird } from '../../species/recording-groups';
import { AUTO_SAVE_RECORDING_PREFIX } from '../../app/controller';

export function recordingsView(ctx: ViewContext): View {
  const { controller } = ctx;
  const list = el('div', { class: 'list', 'data-testid': 'recordings-list' });
  const fileInput = el('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', class: 'sr-only', id: 'import-file' });
  const importBtn = el('label', { class: 'btn', for: 'import-file' }, 'Import audio file');
  const hint = el('p', { class: 'small muted' }, `Saved on this phone only. Imports are analysed here, up to ${MAX_IMPORT_SECONDS} s.`);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    importBtn.textContent = 'Decoding…';
    // An import is an identifying action: start the model load now so the sighting card can analyse at once (DECISIONS.md #69).
    void controller.ensureModel();
    try {
      const decoded = await controller.decodeAudioFile(await file.arrayBuffer());
      const capped = capImportedAudio(decoded);
      if (capped.truncated) ctx.notify({ kind: 'warn', text: `Kept the first ${MAX_IMPORT_SECONDS} s of this ${Math.round(capped.originalSeconds)} s file (the limit).` });
      const rec = await controller.saveRecording(capped.audio, file.name.replace(/\.[^.]+$/, ''), 'import');
      location.hash = hrefFor({ name: 'recording', id: rec.id });
    } catch (e) {
      ctx.notify({ kind: 'error', text: `Could not import: ${(e as Error).message}` });
    } finally {
      importBtn.textContent = 'Import audio file';
      fileInput.value = '';
    }
  });

  /** Groups the visitor opened, kept open when the list redraws (a new clip arrives while it is shown). */
  const openGroups = new Set<string>();
  const render = async () => {
    const recs = await listRecordings().catch(() => []);
    list.replaceChildren();
    if (recs.length === 0) {
      list.appendChild(el('p', { class: 'muted' }, 'No recordings yet. Tap Record while listening, or import a file.'));
      return;
    }
    // One card per bird, opening to its recordings (DECISIONS.md #97), instead of one card per 3 s clip.
    for (const g of groupRecordingsByBird(recs)) {
      const key = g.scientific ?? '';
      const sp = g.scientific ? controller.speciesByScientific(g.scientific) : undefined;
      const count = `${g.recordings.length} recording${g.recordings.length === 1 ? '' : 's'} · latest ${fmtDateTime(g.latest)}`;
      const head = sp
        ? speciesChip(sp, { confidence: g.best, link: false, subtitle: count })
        : el('div', { class: 'chip' }, el('span', { class: 'chip-names' }, el('span', { class: 'chip-common' }, 'No bird found'), el('span', { class: 'chip-sub' }, count)));
      const rows = g.recordings.map((r) => {
        // Auto-saved clips are all named "Detection window: <bird>", which the card already says; show the time instead.
        const title = r.name.startsWith(`${AUTO_SAVE_RECORDING_PREFIX}:`) ? fmtDateTime(r.createdAt) : r.name;
        const also = r.summary.slice(1, 3).map((s) => `${s.common} ${pct(s.maxConfidence)}`);
        return el(
          'a',
          { class: 'list-item recording-row', href: hrefFor({ name: 'recording', id: r.id }), 'data-testid': 'recording-row' },
          el('div', { class: 'title' }, title),
          el('div', { class: 'small muted' }, `${title === r.name ? `${fmtDateTime(r.createdAt)} · ` : ''}${fmtDuration(r.durationSec)} · ${formatBytes(r.bytes)} · ${r.source}${r.summary[0] ? ` · ${pct(r.summary[0].maxConfidence)}` : ''}`),
          also.length ? el('div', { class: 'small muted' }, `Also: ${also.join(', ')}`) : null,
        );
      });
      const group = el('details', { class: 'fold recording-group', 'data-testid': 'recording-group', 'data-species': key, open: openGroups.has(key) }, el('summary', null, head), el('div', { class: 'stack' }, ...rows));
      group.addEventListener('toggle', () => (group.open ? openGroups.add(key) : openGroups.delete(key)));
      list.appendChild(group);
    }
  };
  void render();
  // A recording's bird is known only once its analysis is saved, which can finish after this list is shown.
  const subs = [controller.on('recording-saved', () => void render()), controller.on('detections-changed', () => void render())];

  const root = el('div', null, el('section', { class: 'card' }, el('div', { class: 'row' }, importBtn, fileInput), hint), list);
  return {
    el: root,
    dispose() {
      for (const u of subs) u();
    },
  };
}

const NO_BIRD_TO_LOOK_UP = 'No bird matched confidently, so there’s nothing to look up.';

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
    const confidenceBox = el('div', { class: 'confidence-text', 'data-testid': 'confidence-text' }, el('p', { class: 'small muted' }, 'Not analysed yet.'));
    const detectionsBox = el('div', { class: 'stack', 'data-testid': 'recording-detections' });
    const whyBox = el('div', { class: 'stack' });
    /** The detail level the Why buttons use; set per render from the phone's plan (DECISIONS.md #85). */
    let whyResolution: OcclusionResolution = controller.settings.get().occlusionResolution;
    const spectrogram = new SpectrogramView(specCanvas, specOverlay, 10, 256);

    // Sighting card title: the top bird's common name with its scientific name beneath;
    // "Recording" until something is detected. The recording's own name moves to the meta line.
    const title = el('h2', { 'data-testid': 'recording-title', style: 'margin:0' }, 'Recording');
    const sciName = el('div', { class: 'sci-name', 'data-testid': 'recording-sci', style: 'display:none' }, '');
    const metaLine = el('div', { class: 'small muted' }, `${rec.name} · ${fmtDateTime(rec.createdAt)} · ${fmtDuration(rec.durationSec)} · ${formatBytes(rec.bytes)}`);
    const located = rec.lat != null && rec.lon != null;
    const preview = located ? mapPreview(rec.lat!, rec.lon!, { color: cssToken('accent', '#5FCB97'), label: 'this sighting' }) : null;
    if (preview) disposers.push(preview.dispose);
    const locationPart = located ? el('div', { class: 'stack', 'data-testid': 'sighting-location' }, el('h3', { style: 'margin:8px 0 0' }, 'Location'), preview!.el, locationBlock(rec.lat!, rec.lon!, { accuracy: rec.accuracy, fixTime: rec.fixTime ?? null, time: rec.createdAt })) : el('p', { class: 'small muted' }, 'No position recorded.');
    // "About this bird" and "Ask about this bird" follow the top species; built once it is known.
    const aboutSlot = el('div', { 'data-testid': 'about-slot' }, el('section', { class: 'card' }, el('h2', null, 'About this bird'), el('p', { class: 'small muted' }, 'Analyse to see which bird this is.')));
    const askSlot = el('div', { 'data-testid': 'ask-slot' });
    let topSpecies: Species | null = null;
    const topDisposers: Array<() => void> = [];
    const setTopSpecies = (sp: Species | null) => {
      if (sp?.scientific === topSpecies?.scientific) return;
      topSpecies = sp;
      for (const d of topDisposers.splice(0)) d();
      title.textContent = sp ? sp.common : 'Recording';
      sciName.textContent = sp ? sp.scientific : '';
      sciName.style.display = sp ? '' : 'none';
      preview?.setColor(sp ? speciesColor(sp.scientific).css : cssToken('accent', '#5FCB97'));
      if (!sp) {
        aboutSlot.replaceChildren(el('section', { class: 'card' }, el('h2', null, 'About this bird'), el('p', { class: 'small muted', 'data-testid': 'about-empty' }, rec.analyzedAt != null ? NO_BIRD_TO_LOOK_UP : 'Analyse to see which bird this is.')));
        askSlot.replaceChildren();
        return;
      }
      const about = aboutBird(sp);
      const ask = askBox(ctx.api, sp, () => controller.location.get().location);
      topDisposers.push(about.dispose, ask.dispose);
      aboutSlot.replaceChildren(about.el);
      askSlot.replaceChildren(ask.el);
    };
    disposers.push(() => {
      for (const d of topDisposers) d();
    });

    root.replaceChildren(
      el('section', { class: 'card sighting-card', 'data-testid': 'sighting-card' }, title, sciName, metaLine, player, el('div', { class: 'row' }, analyzeBtn, cancelBtn, exportBtn, deleteBtn), progress, progressText, locationPart),
      // "Why this ID" lives in the Spectrogram card: its result is drawn on this spectrogram (DECISIONS.md #62).
      el(
        'section',
        { class: 'card', 'data-testid': 'spectrogram-card' },
        el('h2', null, 'Spectrogram'),
        specBox,
        el('div', { class: 'viz-label' }, 'Close to what the model sees. Colour strips: species per window. Tap to seek.'),
        confidenceBox,
        el('h3', null, 'Why this ID'),
        el('p', { class: 'small muted' }, 'Mutes one part at a time and re-runs the model to show what the ID depends on.'),
        whyBox,
      ),
      el('section', { class: 'card' }, el('h2', null, 'Detections'), detectionsBox),
      aboutSlot,
      askSlot,
    );
    // Stored summary gives the title straight away; the per-window results refine it below.
    const fromSummary = rec.summary.slice().sort((a, b) => b.maxConfidence - a.maxConfidence)[0];
    if (fromSummary) setTopSpecies(controller.speciesByScientific(fromSummary.scientific) ?? null);

    // Decode once for analysis and drawing.
    const audio = await controller.decodeAudioFile(await rec.blob.arrayBuffer());
    spectrogram.renderStatic(audio);
    const duration = audio.length / SAMPLE_RATE;

    let raf = 0;
    const loop = () => {
      spectrogram.setCursor(player.paused && player.currentTime === 0 ? null : player.currentTime);
      spectrogram.draw();
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
        // Analysed with no match is a result, saved with the recording, not "Not analysed yet" (DECISIONS.md #104).
        const analysed = windows.length > 0 || rec.analyzedAt != null;
        if (!analysed) {
          detectionsBox.appendChild(el('p', { class: 'muted' }, 'Not analysed yet.'));
          whyBox.replaceChildren(el('p', { class: 'muted' }, 'Analyse the recording first.'));
          confidenceBox.replaceChildren(el('p', { class: 'small muted' }, 'Not analysed yet.'));
        } else {
          // While windows arrive, the near misses so far; once settled, the saved ones.
          const near = cancelCurrent ? closestCandidates(windows, controller.species, s.threshold, s.includeNonBird) : (rec.closest ?? []);
          const named = near.map((n) => ({ common: controller.speciesByScientific(n.scientific)?.common ?? n.scientific, prob: n.prob }));
          const listenAgain = el('a', { class: 'btn primary', href: '#/listen', 'data-testid': 'no-match-cta' }, 'Try a longer recording');
          detectionsBox.append(
            el('div', { class: 'stack no-match', 'data-testid': 'no-match' }, el('p', { style: 'margin:0', class: 'no-match-title' }, NO_MATCH_TITLE), ...noMatchLines(named, s.threshold).map((t) => el('p', { class: 'small', style: 'margin:0' }, t)), el('p', { class: 'small muted', style: 'margin:0' }, NO_MATCH_TIP), el('div', { class: 'row' }, listenAgain)),
          );
          whyBox.replaceChildren(el('p', { class: 'muted' }, 'Nothing to explain: no bird matched confidently.'));
          confidenceBox.replaceChildren(el('p', { class: 'small muted' }, `${NO_MATCH_TITLE}: nothing reached your minimum of ${pct(s.threshold)}.`));
        }
        // Keep the title while windows are still arriving; the final render after the analysis settles it.
        if (!cancelCurrent) {
          setTopSpecies(null);
          const aboutEmpty = aboutSlot.querySelector('[data-testid="about-empty"]');
          if (aboutEmpty && analysed) aboutEmpty.textContent = NO_BIRD_TO_LOOK_UP;
        }
        return;
      }
      // Coarse on a phone without WebGL, with a switch to the chosen level (DECISIONS.md #85).
      const plan = planWhy(controller.settings.get().occlusionResolution, controller.inference.getStatus().backend, controller.inference.perPassMs);
      const whyNote = el('p', { class: 'small muted', 'data-testid': 'why-note' }, whyPlanNote(plan));
      const useChosen = el('button', { class: 'btn small', type: 'button', 'data-testid': 'why-use-chosen' }, chosenButtonText(plan));
      whyResolution = plan.resolution;
      useChosen.addEventListener('click', () => {
        whyResolution = plan.chosen;
        whyNote.textContent = `${RESOLUTION_NAME[plan.chosen]} detail, ${plan.chosenPasses} model passes${estimateText(plan.chosenPasses, plan.perPassMs) ? `, ${estimateText(plan.chosenPasses, plan.perPassMs)}` : ''}. Tap a bird below.`;
        useChosen.remove();
      });
      whyBox.replaceChildren(whyNote, plan.reduced ? useChosen : '');
      const ranked = Array.from(perSpecies.entries()).sort((a, b) => b[1].best - a[1].best);
      const top = controller.species[ranked[0][0]] ?? null;
      setTopSpecies(top);
      if (top) {
        // Text instead of the old confidence chart: best confidence vs the minimum, then each matched 3 s window.
        const matched = windows
          .map((w) => ({ offsetSec: w.offsetSec, confidence: selectDetections(w.scores, controller.species, { threshold: s.threshold, applyGeo: false, includeNonBird: s.includeNonBird }).find((d) => d.index === top.index)?.prob ?? null }))
          .filter((w): w is { offsetSec: number; confidence: number } => w.confidence != null);
        const lines = windowLines(matched, duration);
        confidenceBox.replaceChildren(
          el('p', { class: 'tabular', style: 'margin:0', 'data-testid': 'confidence-line' }, confidenceLine(ranked[0][1].best, s.threshold)),
          lines.length > 1
            ? el('div', null, el('p', { class: 'small muted', style: 'margin:4px 0 0' }, `${top.common} matched in ${lines.length} windows:`), el('ul', { class: 'windows-list small tabular', 'data-testid': 'confidence-windows' }, ...lines.map((t) => el('li', null, t))))
            : el('p', { class: 'small muted', style: 'margin:4px 0 0' }, lines.length === 1 ? `Matched in one 3 s window (${lines[0].split(' · ')[0]}).` : ''),
        );
      }
      for (const [index, info] of ranked) {
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

    const applyWindows = () => renderDetections();

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
      analyzeBtn.disabled = true;
      if (controller.inference.getStatus().state !== 'ready') {
        // First identifying action on this phone, or an import that started the load: wait for it here.
        progressText.textContent = 'Loading the bird model…';
        if (!(await controller.ensureModel())) {
          progressText.textContent = MODEL_DOWNLOAD_ERROR;
          analyzeBtn.disabled = false;
          return;
        }
      }
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
      renderDetections();
      cancelBtn.style.display = 'none';
      progress.style.display = 'none';
      // "Analysed" only once the results are saved, so the Recordings list can already group it by bird.
      try {
        if (!cancelled) {
          await persist(s.threshold, s.includeNonBird);
          // Drawn from what was saved, the same as when the recording is opened again.
          renderDetections();
        }
      } finally {
        progressText.textContent = cancelled ? 'Cancelled.' : `Analysed ${windows.length} windows.`;
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = 'Re-analyse';
      }
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
      await recordDetections(records);
      rec.summary = controller.summarize(summaryEntries);
      rec.closest = summaryEntries.length ? [] : closestCandidates(windows, controller.species, threshold, includeNonBird);
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
      const grid = OCCLUSION_GRIDS[whyResolution];
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
        box.replaceChildren(whyExplanation(sp.common, res.baseline, maxDrop, offsetSec, res.timeSteps, res.freqBands), btn);
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
    disposers.push(controller.settings.on('change', () => renderDetections()));
    // Analyse on open when the model is there or on its way (an import starts the load); never start a download just by opening a recording.
    const modelState = controller.inference.getStatus().state;
    if (rec.analyzedAt == null && rec.source !== 'autoclip' && (modelState === 'ready' || modelState === 'loading')) void analyze();
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

function whyExplanation(...args: Parameters<typeof whyExplanationText>): HTMLElement {
  const [first, ...rest] = whyExplanationText(...args);
  return el('div', { class: 'stack', 'data-testid': 'why-explanation' }, el('p', { class: 'small' }, first), ...rest.map((t) => el('p', { class: 'small muted' }, t)));
}
