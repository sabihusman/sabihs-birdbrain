/**
 * Where to re-allow the microphone, by browser. iPhone browsers all use
 * WebKit but keep their permission switch in different places; the user
 * agent tells them apart (CriOS = Chrome, FxiOS = Firefox, EdgiOS = Edge).
 */
export type MicBrowser = 'safari-ios' | 'chrome-ios' | 'firefox-ios' | 'edge-ios' | 'other-ios' | 'not-ios';

export function detectMicBrowser(ua: string): MicBrowser {
  const ios = /iPhone|iPad|iPod/i.test(ua);
  if (!ios) return 'not-ios';
  if (/CriOS/i.test(ua)) return 'chrome-ios';
  if (/FxiOS/i.test(ua)) return 'firefox-ios';
  if (/EdgiOS/i.test(ua)) return 'edge-ios';
  if (/Safari/i.test(ua) && !/\b(OPiOS|OPT|DuckDuckGo|Brave|YaBrowser)\b/i.test(ua)) return 'safari-ios';
  return 'other-ios';
}

export interface MicHelp {
  browser: MicBrowser;
  /** One short sentence per step, plain text. */
  steps: string[];
}

export function micHelp(ua: string): MicHelp {
  const browser = detectMicBrowser(ua);
  switch (browser) {
    case 'chrome-ios':
      return { browser, steps: ['iPhone Settings › Apps › Chrome › Microphone, then reload and tap Allow.'] };
    case 'firefox-ios':
      return { browser, steps: ['iPhone Settings › Apps › Firefox › Microphone, then reload and tap Allow.'] };
    case 'edge-ios':
      return { browser, steps: ['iPhone Settings › Apps › Edge › Microphone, then reload and tap Allow.'] };
    case 'safari-ios':
      return {
        browser,
        steps: ['Settings → Safari → Microphone → Ask or Allow (on iOS 18 and later: Settings › Apps › Safari › Microphone), or tap “aA” in the address bar → Website Settings.', 'Home-screen app: Settings › Apps › Birdbrain › Microphone.', 'Then tap Try again.'],
      };
    case 'other-ios':
      return { browser, steps: ['Settings › Apps › [your browser] › Microphone, then reload and tap Allow.'] };
    default:
      return { browser, steps: ['Allow the microphone for this site in your browser’s site settings (usually the lock or tune icon next to the address), then tap Try again.'] };
  }
}
