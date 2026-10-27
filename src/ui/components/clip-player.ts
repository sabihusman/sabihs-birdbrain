import type { ClipRecord } from '../../storage/types';
import { el, fmtDateTime, fmtDuration, pct } from '../dom';

/** Play button plus date and confidence for a species' saved clip. Audio stays a local blob URL. */
export function clipPlayer(clip: ClipRecord): { el: HTMLElement; audio: HTMLAudioElement; dispose: () => void } {
  const url = URL.createObjectURL(clip.blob);
  const audio = new Audio(url);
  audio.preload = 'metadata';
  const btn = el('button', { class: 'btn small primary', type: 'button', 'data-testid': 'clip-play', 'aria-label': `Play the saved ${clip.common} clip` }, '▶ Play clip');
  const meta = el('div', { class: 'small muted', 'data-testid': 'clip-meta' }, `${fmtDuration(clip.durationSec)} · ${fmtDateTime(clip.time)} · ${pct(clip.confidence)} confidence · ${clip.source === 'live' ? 'live listening' : clip.source === 'import' ? 'imported file' : 'recording'}`);
  const update = () => {
    btn.textContent = audio.paused ? '▶ Play clip' : '■ Stop';
  };
  btn.addEventListener('click', () => {
    if (audio.paused) void audio.play().catch(() => undefined);
    else {
      audio.pause();
      audio.currentTime = 0;
    }
  });
  audio.addEventListener('play', update);
  audio.addEventListener('pause', update);
  audio.addEventListener('ended', update);
  return {
    el: el('div', { class: 'clip-player' }, el('div', { class: 'row' }, btn, el('span', { class: 'small' }, 'Raw, unfiltered audio')), meta),
    /** The element that plays the clip (the ID card reads currentTime for its cursor and seeks by tap). */
    audio,
    dispose() {
      audio.pause();
      audio.src = '';
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * The saved clip on a Listen card that stays on screen for the whole session (DECISIONS.md #99):
 * `refresh()` looks the clip up again and swaps in a newer one, but never while one is playing.
 */
export interface ClipLoaders {
  /** The clip's details only (cheap: no audio read). */
  meta: (scientific: string) => Promise<{ savedAt: number } | undefined>;
  clip: (scientific: string) => Promise<ClipRecord | undefined>;
}

export function clipSlot(parent: HTMLElement, scientific: string, classes: string[], load: ClipLoaders): { refresh: () => void; dispose: () => void } {
  let current: { savedAt: number; player: ReturnType<typeof clipPlayer> } | null = null;
  let busy = false;
  let disposed = false;
  return {
    refresh() {
      if (busy || disposed) return;
      busy = true;
      const unchanged = (savedAt: number | undefined) => savedAt == null || disposed || current?.savedAt === savedAt || (current != null && !current.player.audio.paused);
      void load
        .meta(scientific)
        .then((meta) => (unchanged(meta?.savedAt) ? undefined : load.clip(scientific)))
        .then((clip) => {
          if (!clip || unchanged(clip.savedAt)) return;
          current?.player.el.remove();
          current?.player.dispose();
          const player = clipPlayer(clip);
          player.el.classList.add(...classes);
          parent.appendChild(player.el);
          current = { savedAt: clip.savedAt, player };
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    },
    dispose() {
      disposed = true;
      current?.player.dispose();
    },
  };
}
