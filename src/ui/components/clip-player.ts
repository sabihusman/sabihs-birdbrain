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
