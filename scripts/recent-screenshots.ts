/**
 * Screenshots of Listen → "Recent sightings" grouped cards (collapsed and expanded) in both themes
 * at iPhone size, from a running preview server:
 *   npm run build && (npm run preview -- --port 4173 &) && npx tsx scripts/recent-screenshots.ts
 */
import { chromium, devices } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const out = path.resolve(import.meta.dirname, '../docs/screenshots');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
for (const theme of ['dark', 'light'] as const) {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem('birdbrain.theme.v1', t), theme);
  await page.goto(BASE);
  await page.getByTestId('model-status').filter({ hasText: 'Model ready' }).waitFor({ timeout: 240_000 });
  await page.getByTestId('demo').click();
  await page.getByTestId('listen-status').filter({ hasText: /Sample analysed/ }).waitFor({ timeout: 120_000 });
  await page.getByTestId('recent-fold').locator('summary').click();
  await page.getByTestId('recent-card').first().waitFor();
  await page.getByTestId('recent-fold').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `listen-recent-grouped-${theme}.png`) });
  await page.getByTestId('recent-card').first().click();
  await page.getByTestId('recent-rows').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `listen-recent-expanded-${theme}.png`) });
  await context.close();
  console.log('done', theme);
}
await browser.close();
