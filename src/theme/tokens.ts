/**
 * Theme tokens from docs/DESIGN_GUIDE.md §3. The CSS in src/styles.css mirrors
 * these values; canvases and tests read them from here (or from the computed
 * CSS variables at runtime) so no colour is hard-coded twice.
 *
 * Deviations from the guide's starting values, all for WCAG AA (recorded in
 * DECISIONS.md #37): light `--warn` #A8661B → #8F5614 (4.26:1 → 5.4:1 on the
 * card as text) and light `--muted` #6A7066 → #5F665C (4.33:1 → 5.2:1 on the
 * page).
 */
export type Theme = 'dark' | 'light';

export interface ThemeTokens {
  page: string;
  panel: string;
  onPanel: string;
  card: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  live: string;
  sage: string;
  clay: string | null;
  ok: string;
  warn: string;
  error: string;
  focus: string;
  /** Background of the spectrogram/timeline canvases (the colour map needs a dark field in both themes). */
  vizBg: string;
  vizFg: string;
}

export const THEME_TOKENS: Record<Theme, ThemeTokens> = {
  dark: {
    page: '#121A17',
    panel: '#1C2A25',
    onPanel: '#E4EDE8',
    card: '#1A2420',
    line: '#2A3833',
    text: '#E4EDE8',
    muted: '#93A39C',
    accent: '#5FCB97',
    onAccent: '#0B1F16',
    live: '#5FCB97',
    sage: '#2A3833',
    clay: null,
    ok: '#5FCB97',
    warn: '#E8B36A',
    error: '#E07A5F',
    focus: '#E8B36A',
    vizBg: '#000004',
    vizFg: '#E4EDE8',
  },
  light: {
    page: '#F4ECDA',
    panel: '#2F5A48',
    onPanel: '#F8F3E6',
    card: '#FBF6EC',
    line: '#E3D9C2',
    text: '#24302A',
    muted: '#5F665C',
    accent: '#2F5A48',
    onAccent: '#FFFFFF',
    live: '#B9D3B0',
    sage: '#A9BDA9',
    clay: '#C78358',
    ok: '#2F7A55',
    warn: '#8F5614',
    error: '#B5432C',
    focus: '#A8661B',
    vizBg: '#000004',
    vizFg: '#F8F3E6',
  },
};

export const THEME_NAMES: Record<Theme, string> = { dark: 'Forest Night', light: 'Field Guide, cream' };

/** Text pairs that must reach WCAG AA 4.5:1, and UI pairs that must reach 3:1 (checked in tests/theme-contrast.test.ts). */
export const TEXT_PAIRS: ReadonlyArray<[keyof ThemeTokens, keyof ThemeTokens]> = [
  ['text', 'card'],
  ['text', 'page'],
  ['muted', 'card'],
  ['muted', 'page'],
  ['accent', 'card'],
  ['accent', 'page'],
  ['onAccent', 'accent'],
  ['onPanel', 'panel'],
  ['ok', 'card'],
  ['warn', 'card'],
  ['error', 'card'],
  ['vizFg', 'vizBg'],
];
export const UI_PAIRS: ReadonlyArray<[keyof ThemeTokens, keyof ThemeTokens]> = [
  ['focus', 'page'],
  ['focus', 'card'],
  ['live', 'panel'],
];
