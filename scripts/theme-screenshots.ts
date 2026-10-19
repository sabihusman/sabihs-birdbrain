/**
 * Design-guide §11 screenshots: Listen in Ready, Listening and Mic-blocked states, plus the
 * species page, in both themes at iPhone size, from a running preview server.
 *   npm run build && (npm run preview -- --port 4173 &) && npx tsx scripts/theme-screenshots.ts
 * The listening state uses Chromium's fake microphone; the blocked state a context that denies it.
 */
import { chromium, devices, type Browser } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const out = path.resolve(import.meta.dirname, '../docs/screenshots');
fs.mkdirSync(out, { recursive: true });
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
const LAYOUT = process.env.LAYOUT ?? 'consolidated';

async function withPage(browser: Browser, theme: 'dark' | 'light', mic: 'fake' | 'denied', run: (page: import('@playwright/test').Page) => Promise<void>) {
  const context = await browser.newContext({ ...devices['iPhone 13'], permissions: mic === 'fake' ? ['microphone'] : [] });
  const page = await context.newPage();
  await page.addInitScript(
    ({ t, layout }) => {
      localStorage.setItem('birdbrain.theme.v1', t);
      // Listen layout (PR 5 onwards; ignored by builds without it).
      try {
        const raw = localStorage.getItem('birdbrain.settings.v1');
        const s = raw ? JSON.parse(raw) : {};
        s.listenLayout = layout;
        localStorage.setItem('birdbrain.settings.v1', JSON.stringify(s));
      } catch {
        /* ignore */
      }
    },
    { t: theme, layout: LAYOUT },
  );
  await run(page);
  await context.close();
}

const fake = await chromium.launch({ args: [...GL, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const plain = await chromium.launch({ args: GL });
for (const theme of ['dark', 'light'] as const) {
  const suffix = `${LAYOUT}-${theme}`;
  await withPage(fake, theme, 'fake', async (page) => {
    await page.goto(BASE);
    await page.getByTestId('model-status').filter({ hasText: 'Model ready' }).waitFor({ timeout: 240_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, `listen-ready-${suffix}.png`) });
    await page.getByTestId('start-stop').click();
    await page.getByTestId('listen-status').filter({ hasText: /Listening/ }).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(out, `listen-listening-${suffix}.png`) });
    await page.getByTestId('start-stop').click();
    await page.goto(`${BASE}#/species/Acanthis%20cabaret`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(out, `species-${theme}.png`) });
    await page.goto(`${BASE}#/settings`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `settings-${theme}.png`) });
  });
  await withPage(plain, theme, 'denied', async (page) => {
    await page.goto(BASE);
    await page.getByTestId('model-status').filter({ hasText: 'Model ready' }).waitFor({ timeout: 240_000 });
    await page.getByTestId('start-stop').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, `listen-mic-blocked-${suffix}.png`) });
  });
  console.log('done', suffix);
}
await fake.close();
await plain.close();
