/** Render public/icons/icon.svg to the PNG sizes the manifest and iOS need. */
import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public/icons/icon.svg'), 'utf8');

async function render(size: number, out: string, padding = 0) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const inner = size - padding * 2;
  await page.setContent(
    `<html><body style="margin:0;background:#0f1a14;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace(/width="512" height="512"/, `width="${inner}" height="${inner}"`)}</div></body></html>`,
  );
  await page.screenshot({ path: out, type: 'png', omitBackground: padding === 0 });
  await browser.close();
  console.log('wrote', out);
}

const icons = path.join(root, 'public/icons');
await render(192, path.join(icons, 'icon-192.png'));
await render(512, path.join(icons, 'icon-512.png'));
// Maskable: full-bleed background with the artwork in the safe zone.
await render(512, path.join(icons, 'icon-maskable-512.png'), 64);
await render(180, path.join(root, 'public/apple-touch-icon.png'));
await render(64, path.join(root, 'public/favicon.png'));
