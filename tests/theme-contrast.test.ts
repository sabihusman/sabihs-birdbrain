import { describe, expect, it } from 'vitest';
import { speciesColor } from '../src/species/colors';
import { AA_TEXT, AA_UI, contrastRatio } from '../src/theme/contrast';
import { TEXT_PAIRS, THEME_TOKENS, UI_PAIRS, type Theme } from '../src/theme/tokens';

const themes: Theme[] = ['dark', 'light'];
const sample = ['Turdus merula', 'Parus major', 'Erithacus rubecula', 'Acanthis cabaret', 'Cyanocitta cristata', 'Sturnus vulgaris', 'Columba palumbus', 'Fringilla coelebs', 'Hirundo rustica', 'Strix aluco', 'Corvus corax', 'Troglodytes troglodytes', 'Phylloscopus collybita', 'Buteo buteo', 'Alcedo atthis', 'Motacilla alba', 'Passer domesticus', 'Pica pica', 'Regulus regulus', 'Sylvia atricapilla'];

describe('theme tokens meet WCAG AA', () => {
  for (const theme of themes) {
    const t = THEME_TOKENS[theme];
    it(`${theme}: text pairs reach ${AA_TEXT}:1`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        const ratio = contrastRatio(t[fg] as string, t[bg] as string);
        expect(ratio, `${theme} ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });
    it(`${theme}: focus ring, meter, borders and accent-on-panel reach ${AA_UI}:1`, () => {
      for (const [fg, bg] of UI_PAIRS) {
        const ratio = contrastRatio(t[fg] as string, t[bg] as string);
        expect(ratio, `${theme} ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_UI);
      }
    });
  }

  it('the clay accent is never a status colour and is absent from the dark theme', () => {
    expect(THEME_TOKENS.dark.clay).toBeNull();
    const l = THEME_TOKENS.light;
    expect([l.ok, l.warn, l.error, l.focus]).not.toContain(l.clay);
  });
});

describe('species colours against the card', () => {
  it('reach 3:1 on the dark card on their own', () => {
    for (const s of sample) {
      const ratio = contrastRatio(speciesColor(s).rgb, THEME_TOKENS.dark.card);
      expect(ratio, `${s} on dark card = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it('on the cream card most fall short, so the dot carries a 1 px ring in the muted colour that itself reaches 3:1', () => {
    // The species colour is never changed (design guide §3.4): the ring is the fix.
    const failing = sample.filter((s) => contrastRatio(speciesColor(s).rgb, THEME_TOKENS.light.card) < AA_UI);
    expect(failing.length).toBeGreaterThan(0);
    for (const theme of themes) {
      const t = THEME_TOKENS[theme];
      expect(contrastRatio(t.muted, t.card)).toBeGreaterThanOrEqual(AA_UI);
    }
  });
});
