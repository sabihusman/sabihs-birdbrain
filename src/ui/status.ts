import type { AppController } from '../app/controller';
import { MODEL_DOWNLOAD_ERROR } from '../model/model-source';

/** The states of docs/DESIGN_GUIDE.md §7, derived from the controller. */
export type ListenStatus = 'idle' | 'loading' | 'ready' | 'listening' | 'paused' | 'mic-blocked' | 'error' | 'offline';

export interface StatusView {
  status: ListenStatus;
  /** Pill text ("Loading model 42%", "Listening", …). */
  pill: string;
  /** Short glyph, always next to the text (colour is never the only signal). */
  icon: string;
  tone: 'muted' | 'ok' | 'warn' | 'error';
  /** Replaces the state block's default hint when this state has something specific to say. */
  hint?: string;
}

export function listenStatus(controller: AppController, online = typeof navigator === 'undefined' ? true : navigator.onLine): StatusView {
  const model = controller.inference.getStatus();
  const mic = controller.getMicError();
  // The model is downloaded from the API host (src/model/model-source.ts), so this is
  // nearly always a connection problem; say that instead of "Something went wrong".
  if (model.state === 'error') return { status: 'error', pill: 'Model not loaded', icon: '⚠', tone: 'error', hint: MODEL_DOWNLOAD_ERROR };
  // Nothing asked for the model yet (first visit, welcome layer up): not an error, not a download.
  if (model.state === 'idle') return { status: 'idle', pill: 'Model not loaded', icon: '◌', tone: 'muted' };
  if (model.state !== 'ready') return { status: 'loading', pill: `Loading model ${Math.round((model.progress ?? 0) * 100)}%`, icon: '◌', tone: 'muted' };
  if (controller.listening) {
    return controller.engine.getState() === 'suspended' ? { status: 'paused', pill: 'Paused', icon: '❚❚', tone: 'warn' } : { status: 'listening', pill: 'Listening', icon: '●', tone: 'ok' };
  }
  if (mic?.kind === 'denied') return { status: 'mic-blocked', pill: 'Mic blocked', icon: '⊘', tone: 'error' };
  if (mic) return { status: 'error', pill: 'Something went wrong', icon: '⚠', tone: 'error' };
  if (!online) return { status: 'offline', pill: 'Offline', icon: '◦', tone: 'warn' };
  return { status: 'ready', pill: 'Model ready', icon: '✓', tone: 'ok' };
}

/** "just now", "0:40 ago", "12 min ago". */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} ago`;
  return `${Math.floor(s / 3600)} h ago`;
}
