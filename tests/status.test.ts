import { describe, expect, it } from 'vitest';
import { listenStatus, timeAgo } from '../src/ui/status';
import type { AppController } from '../src/app/controller';
import { BROWSER_UNSUPPORTED_HINT, BROWSER_UNSUPPORTED_TEXT, NO_CONNECTION_TEXT } from '../src/app/browser-support';
import { MODEL_DOWNLOAD_ERROR } from '../src/model/model-source';

function fakeController(o: { model?: string; progress?: number; listening?: boolean; engine?: string; mic?: { kind: string; message: string } | null; failure?: { unsupported: boolean; text: string } | null }): AppController {
  return {
    inference: { getStatus: () => ({ state: o.model ?? 'ready', progress: o.progress ?? 1, backend: 'webgl' }) },
    getModelFailure: () => o.failure ?? null,
    getMicError: () => o.mic ?? null,
    listening: o.listening ?? false,
    engine: { getState: () => o.engine ?? (o.listening ? 'running' : 'stopped') },
  } as unknown as AppController;
}

describe('Listen status (DESIGN_GUIDE.md §7)', () => {
  it('maps model, engine, microphone and network state to the pill text and icon', () => {
    expect(listenStatus(fakeController({ model: 'loading', progress: 0.42 }), true)).toMatchObject({ status: 'loading', pill: 'Loading model 42%' });
    expect(listenStatus(fakeController({}), true)).toMatchObject({ status: 'ready', pill: 'Model ready', tone: 'ok' });
    expect(listenStatus(fakeController({ listening: true }), true)).toMatchObject({ status: 'listening', pill: 'Listening' });
    expect(listenStatus(fakeController({ listening: true, engine: 'suspended' }), true)).toMatchObject({ status: 'paused', pill: 'Paused', tone: 'warn' });
    expect(listenStatus(fakeController({ mic: { kind: 'denied', message: 'x' } }), true)).toMatchObject({ status: 'mic-blocked', pill: 'Mic blocked', tone: 'error' });
    expect(listenStatus(fakeController({ mic: { kind: 'busy', message: 'x' } }), true)).toMatchObject({ status: 'error', pill: 'Something went wrong' });
    expect(listenStatus(fakeController({ model: 'error' }), true)).toMatchObject({ status: 'error', hint: MODEL_DOWNLOAD_ERROR });
    // A failed download names its reason (DECISIONS.md #65); an unsupported browser is its own state with no "Try again".
    expect(listenStatus(fakeController({ model: 'error', failure: { unsupported: false, text: NO_CONNECTION_TEXT } }), true)).toMatchObject({ status: 'error', pill: 'Model not loaded', hint: NO_CONNECTION_TEXT });
    expect(listenStatus(fakeController({ model: 'idle', failure: { unsupported: true, text: BROWSER_UNSUPPORTED_TEXT } }), true)).toMatchObject({ status: 'unsupported', pill: 'Browser not supported', tone: 'error', hint: BROWSER_UNSUPPORTED_HINT });
    expect(listenStatus(fakeController({}), false)).toMatchObject({ status: 'offline', pill: 'Offline' });
    // every state carries text and an icon: colour is never the only signal
    for (const c of [fakeController({}), fakeController({ listening: true }), fakeController({ mic: { kind: 'denied', message: '' } })]) {
      const s = listenStatus(c, true);
      expect(s.pill.length).toBeGreaterThan(0);
      expect(s.icon.length).toBeGreaterThan(0);
    }
  });

  it('formats relative times as the guide shows them', () => {
    const now = 1_000_000_000;
    expect(timeAgo(now - 2000, now)).toBe('just now');
    expect(timeAgo(now - 40_000, now)).toBe('0:40 ago');
    expect(timeAgo(now - 754_000, now)).toBe('12:34 ago');
    expect(timeAgo(now - 2 * 3_600_000, now)).toBe('2 h ago');
  });
});
