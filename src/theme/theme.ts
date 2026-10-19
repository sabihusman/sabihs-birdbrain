import { THEME_TOKENS, type Theme } from './tokens';

export const THEME_KEY = 'birdbrain.theme.v1';
export const DEFAULT_THEME: Theme = 'dark';

export function isTheme(v: unknown): v is Theme {
  return v === 'dark' || v === 'light';
}

/** The stored choice, or dark. Storage access is wrapped: a private window or blocked storage falls back to dark. */
export function readStoredTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Theme {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(theme: Theme, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    storage?.setItem(THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Apply a theme to the document: the data attribute the CSS keys on, plus the browser-chrome colour. */
export function applyTheme(theme: Theme, doc: Document = document): void {
  doc.documentElement.setAttribute('data-theme', theme);
  for (const meta of Array.from(doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))) meta.content = THEME_TOKENS[theme].page;
}

export function currentTheme(doc: Document = document): Theme {
  const v = doc.documentElement.getAttribute('data-theme');
  return isTheme(v) ? v : DEFAULT_THEME;
}

export function otherTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

/** Read a theme token from the live CSS variables (canvases call this on every draw so a toggle repaints them). */
export function cssToken(name: string, fallback: string, el: Element = document.documentElement): string {
  const v = getComputedStyle(el).getPropertyValue(`--${name}`).trim();
  return v || fallback;
}
