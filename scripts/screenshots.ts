/**
 * Take README screenshots at iPhone size from a running preview server.
 *   npm run build && (npm run preview -- --port 4173 &) && npx tsx scripts/screenshots.ts
 */
import { chromium, devices } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const out = path.resolve(import.meta.dirname, '../docs/screenshots');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
for (const scheme of ['light', 'dark'] as const) {
  const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(BASE);
  await page.getByTestId('model-status').filter({ hasText: 'Model ready' }).waitFor({ timeout: 240_000 });
  await page.getByTestId('demo').click();
  await page.getByTestId('results').filter({ hasText: 'Redpoll' }).waitFor({ timeout: 120_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `listen-${scheme}.png`) });
  await page.goto(`${BASE}#/species/Acanthis%20cabaret`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `species-${scheme}.png`) });
  // Settings in both themes: the grouped account rows, and the pipeline section open on Listen.
  await page.goto(`${BASE}#/settings`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `settings-${scheme}.png`) });
  await page.goto(`${BASE}#/listen`);
  await page.getByTestId('how-it-works').getByText('How it works').click();
  await page.getByTestId('pipeline').getByText('How BirdNET decides').click();
  await page.getByTestId('pipeline-list').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, `how-birdnet-decides-${scheme}.png`) });
  if (scheme === 'light') {
    await page.goto(`${BASE}#/species`);
    await page.getByRole('searchbox').fill('warbler');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, 'species-list.png') });
    await page.goto(`${BASE}#/map`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(out, 'map.png') });
    await page.goto(`${BASE}#/recordings`);
    await page.locator('#import-file').setInputFiles(path.resolve(import.meta.dirname, '../public/samples/birdnet-sample.wav'));
    await page.waitForURL(/#\/recordings\/.+/, { timeout: 60_000 });
    await page.getByText(/Analysed \d+ windows/).waitFor({ timeout: 120_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, 'recording-detail.png') });
    await page.getByRole('button', { name: /^Why Lesser Redpoll/ }).click();
    await page.getByText(/baseline \d+%/).waitFor({ timeout: 240_000 });
    await page.locator('.viz').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, 'why-this-id.png') });
    await page.goto(`${BASE}#/recordings`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, 'recordings.png') });
  }
  await context.close();
  console.log('done', scheme);
}
await browser.close();
