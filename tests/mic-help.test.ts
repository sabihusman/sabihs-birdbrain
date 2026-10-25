import { describe, expect, it } from 'vitest';
import { detectMicBrowser, micHelp } from '../src/ui/mic-help';

const UA = {
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15',
  edge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.2849.56 Mobile/15E148 Safari/605.1.15',
  duck: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
};

describe('microphone help by browser', () => {
  it('tells iPhone browsers apart by their user-agent tokens', () => {
    expect(detectMicBrowser(UA.safari)).toBe('safari-ios');
    expect(detectMicBrowser(UA.chrome)).toBe('chrome-ios');
    expect(detectMicBrowser(UA.firefox)).toBe('firefox-ios');
    expect(detectMicBrowser(UA.edge)).toBe('edge-ios');
    expect(detectMicBrowser(UA.duck)).toBe('other-ios');
    expect(detectMicBrowser(UA.android)).toBe('not-ios');
  });

  it('gives Chrome-on-iOS its own path, Safari its own, and a generic Apps path otherwise', () => {
    expect(micHelp(UA.chrome).steps[0]).toBe('iPhone Settings › Apps › Chrome › Microphone, then reload and tap Allow.');
    expect(micHelp(UA.safari).steps.join(' ')).toContain('Tap “aA” in the address bar › Website Settings › Microphone.');
    expect(micHelp(UA.safari).steps.join(' ')).toContain('(older iOS: Settings › Safari)');
    expect(micHelp(UA.safari).steps.join(' ')).toContain('Settings › Apps › Safari › Microphone');
    expect(micHelp(UA.duck).steps[0]).toBe('Settings › Apps › [your browser] › Microphone, then reload and tap Allow.');
    expect(micHelp(UA.android).steps[0]).toMatch(/site settings/);
  });
});
