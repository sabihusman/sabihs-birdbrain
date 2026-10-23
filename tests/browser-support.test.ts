import { describe, expect, it } from 'vitest';
import { BROWSER_UNSUPPORTED_TEXT, BrowserUnsupportedError, checkBrowserSupport, describeModelFailure, NO_CONNECTION_TEXT, NO_STORAGE_TEXT } from '../src/app/browser-support';
import { MODEL_DOWNLOAD_ERROR } from '../src/model/model-source';

/** A browser with everything the model needs; each test removes one thing. */
function browser(): Record<string, unknown> {
  return { WebAssembly: {}, Worker: class {}, indexedDB: {}, AudioContext: class {} };
}

describe('checkBrowserSupport (DECISIONS.md #69)', () => {
  it('passes a current browser, with or without WebGL', () => {
    expect(checkBrowserSupport(browser())).toEqual({ ok: true });
    // WebGL is optional: the worker falls back to the WebAssembly backend.
    expect(checkBrowserSupport({ ...browser(), WebGLRenderingContext: undefined, OffscreenCanvas: undefined })).toEqual({ ok: true });
  });

  it('accepts the prefixed AudioContext older Safari ships', () => {
    const g = browser();
    delete g.AudioContext;
    g.webkitAudioContext = class {};
    expect(checkBrowserSupport(g)).toEqual({ ok: true });
  });

  it('names the first missing requirement', () => {
    for (const [key, reason] of [
      ['WebAssembly', 'no-wasm'],
      ['Worker', 'no-worker'],
      ['indexedDB', 'no-indexeddb'],
      ['AudioContext', 'no-audio'],
    ] as const) {
      const g = browser();
      g[key] = undefined;
      expect(checkBrowserSupport(g), key).toEqual({ ok: false, reason });
      delete g[key];
      expect(checkBrowserSupport(g), `${key} absent`).toEqual({ ok: false, reason });
    }
  });

  it('reads the real globals by default', () => {
    // Node lacks the browser globals; only the shape of the answer is checked here.
    const r = checkBrowserSupport();
    expect(typeof r.ok).toBe('boolean');
  });
});

describe('describeModelFailure', () => {
  it('says the browser is not supported', () => {
    expect(describeModelFailure(new BrowserUnsupportedError('no-wasm'), true)).toBe(BROWSER_UNSUPPORTED_TEXT);
    expect(new BrowserUnsupportedError('no-worker').reason).toBe('no-worker');
    // The worker forwards errors by name and message only.
    expect(describeModelFailure(Object.assign(new Error('x'), { name: 'BrowserUnsupportedError' }), true)).toBe(BROWSER_UNSUPPORTED_TEXT);
  });

  it('says there is no connection for a failed fetch or an offline phone', () => {
    expect(describeModelFailure(new TypeError('Failed to fetch'), true)).toBe(NO_CONNECTION_TEXT);
    // Through the worker the TypeError arrives as a plain Error with the browser's message.
    expect(describeModelFailure(new Error('Failed to fetch'), true)).toBe(NO_CONNECTION_TEXT);
    expect(describeModelFailure(new Error('NetworkError when attempting to fetch resource.'), true)).toBe(NO_CONNECTION_TEXT);
    expect(describeModelFailure(new Error('Load failed'), true)).toBe(NO_CONNECTION_TEXT);
    expect(describeModelFailure(new Error('HTTP 503'), false)).toBe(NO_CONNECTION_TEXT);
  });

  it('says there is not enough storage for a quota error', () => {
    expect(describeModelFailure(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }), true)).toBe(NO_STORAGE_TEXT);
    expect(describeModelFailure(Object.assign(new Error('x'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' }), true)).toBe(NO_STORAGE_TEXT);
    expect(describeModelFailure(new Error('Cache quota exceeded'), true)).toBe(NO_STORAGE_TEXT);
    // Storage wins over "offline": clearing space is what helps.
    expect(describeModelFailure(Object.assign(new Error('x'), { name: 'QuotaExceededError' }), false)).toBe(NO_STORAGE_TEXT);
  });

  it('keeps the generic text for anything else', () => {
    expect(describeModelFailure(new Error('HTTP 500 for acoustic/model.json'), true)).toBe(MODEL_DOWNLOAD_ERROR);
    expect(describeModelFailure('weird', true)).toBe(MODEL_DOWNLOAD_ERROR);
    expect(describeModelFailure(undefined, true)).toBe(MODEL_DOWNLOAD_ERROR);
  });

  it('every reason is a plain sentence with no jargon', () => {
    for (const t of [BROWSER_UNSUPPORTED_TEXT, NO_CONNECTION_TEXT, NO_STORAGE_TEXT, MODEL_DOWNLOAD_ERROR]) {
      expect(t).not.toMatch(/WebAssembly|WASM|WebGL|quota|TypeError|fetch/i);
      expect(t).not.toContain('!');
    }
  });
});
