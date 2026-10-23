/**
 * Can this browser run the bird model at all, and if a load failed, why (DECISIONS.md #69)?
 *
 * The check runs once, before any model byte is requested, so a browser that cannot run
 * BirdNET never starts a 78 MB download it cannot use. WebGL is not required: the worker
 * falls back to the WebAssembly backend (src/model/inference.worker.ts), so WebAssembly is
 * the one compute requirement. The others are what the app needs around the model: a Web
 * Worker to run it in, IndexedDB for sightings, and an AudioContext for the microphone.
 */
import { MODEL_DOWNLOAD_ERROR } from '../model/model-source';

export type UnsupportedReason = 'no-wasm' | 'no-worker' | 'no-indexeddb' | 'no-audio';

export type BrowserSupport = { ok: true } | { ok: false; reason: UnsupportedReason };

/** What the Listen panel says when the browser cannot run the model (title, then hint). */
export const BROWSER_UNSUPPORTED_TITLE = "This browser can't run the bird model.";
export const BROWSER_UNSUPPORTED_HINT = 'It works in current Safari, Chrome, Firefox and Edge.';
export const BROWSER_UNSUPPORTED_TEXT = `${BROWSER_UNSUPPORTED_TITLE} ${BROWSER_UNSUPPORTED_HINT}`;

/** Plain words for a download that failed because the phone is offline. */
export const NO_CONNECTION_TEXT = 'No connection. The bird model downloads once, about 78 MB, so connect to Wi-Fi and try again.';
/** Plain words for a download the browser refused to store. */
export const NO_STORAGE_TEXT = 'Not enough storage. The bird model needs about 78 MB free on this phone. Clear some space and try again.';

type Globals = Record<string, unknown>;

/** The first missing requirement, in the order the app would hit them. `g` is a parameter for the tests. */
export function checkBrowserSupport(g: Globals = globalThis as unknown as Globals): BrowserSupport {
  if (typeof g.WebAssembly !== 'object' || g.WebAssembly === null) return { ok: false, reason: 'no-wasm' };
  if (typeof g.Worker !== 'function') return { ok: false, reason: 'no-worker' };
  if (typeof g.indexedDB !== 'object' || g.indexedDB === null) return { ok: false, reason: 'no-indexeddb' };
  if (typeof g.AudioContext !== 'function' && typeof g.webkitAudioContext !== 'function') return { ok: false, reason: 'no-audio' };
  return { ok: true };
}

/** Thrown by the controller instead of starting a download the browser cannot run. */
export class BrowserUnsupportedError extends Error {
  override readonly name = 'BrowserUnsupportedError';
  constructor(readonly reason: UnsupportedReason) {
    super(BROWSER_UNSUPPORTED_TEXT);
  }
}

/** Browser wording for a fetch that never reached the server (Chrome, Firefox, Safari). */
const NETWORK_MESSAGE = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * One plain sentence for a failed model load. The worker forwards errors as a message
 * string (src/model/protocol.ts), so the `TypeError` a failed fetch throws arrives here as
 * a plain Error; the message text is matched as well as the name.
 */
export function describeModelFailure(err: unknown, online: boolean = typeof navigator === 'undefined' ? true : navigator.onLine): string {
  if (err instanceof BrowserUnsupportedError) return BROWSER_UNSUPPORTED_TEXT;
  const e = err instanceof Error ? err : null;
  const name = e?.name ?? '';
  const message = e?.message ?? String(err ?? '');
  if (name === 'BrowserUnsupportedError') return BROWSER_UNSUPPORTED_TEXT;
  if (/quota/i.test(name) || /quota/i.test(message)) return NO_STORAGE_TEXT;
  if (!online || name === 'TypeError' || NETWORK_MESSAGE.test(message)) return NO_CONNECTION_TEXT;
  return MODEL_DOWNLOAD_ERROR;
}
