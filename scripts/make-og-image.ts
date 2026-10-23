/**
 * Render public/og-image.png, the 1200×630 link preview (Open Graph / Twitter card) that
 * index.html points at. Same approach as make-icons.ts: Playwright's Chromium renders a
 * small HTML page and screenshots it. The art is public/icons/icon.svg, the colours are
 * the dark "Forest Night" theme (src/theme/tokens.ts), and the font is Inter, the first
 * choice in src/styles.css (it must be installed on the machine that runs this; the
 * fallback is the system sans-serif). DECISIONS.md #68.
 *
 *   npx tsx scripts/make-og-image.ts
 */
import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { THEME_TOKENS } from '../src/theme/tokens';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public/icons/icon.svg'), 'utf8');
const dark = THEME_TOKENS.dark;

const ICON = 400;
const html =
  `<html><body style="margin:0;width:${OG_WIDTH}px;height:${OG_HEIGHT}px;background:${dark.page};` +
  `font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;color:${dark.text};` +
  `display:flex;align-items:center;gap:72px;padding:0 96px;box-sizing:border-box">` +
  `<div style="flex:none;width:${ICON}px;height:${ICON}px">${svg.replace(/width="512" height="512"/, `width="${ICON}" height="${ICON}"`)}</div>` +
  `<div style="min-width:0">` +
  `<div style="font-size:76px;font-weight:700;letter-spacing:-0.02em;line-height:1.1">Sabih’s Birdbrain</div>` +
  `<div style="font-size:36px;line-height:1.35;margin-top:28px;color:${dark.muted}">Listens and tells you which birds are singing. Runs on your phone, so your audio never leaves it.</div>` +
  `<div style="font-size:30px;line-height:1.35;margin-top:36px;color:${dark.accent}">sabihs-birdbrain.vercel.app</div>` +
  `</div></body></html>`;

const out = path.join(root, 'public/og-image.png');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: OG_WIDTH, height: OG_HEIGHT }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: out, type: 'png' });
await browser.close();
console.log('wrote', out);
