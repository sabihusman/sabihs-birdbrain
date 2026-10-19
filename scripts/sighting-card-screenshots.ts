/**
 * Sighting card screenshots (DECISIONS.md #45): the recording detail opened from Recordings
 * after importing the bundled BirdNET sample clip, in both themes, signed out and signed in
 * (an approved member faked through the cached session in localStorage, as the e2e test does;
 * the API is blocked so nothing is sent anywhere). A manual position gives the card a map.
 *   npm run build && (npm run preview -- --port 4173 &) && npx tsx scripts/sighting-card-screenshots.ts
 * Writes docs/screenshots/sighting-card-{dark,light}-{signed-in,signed-out}.png (full page).
 */
import { chromium, devices } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const out = path.resolve(import.meta.dirname, '../docs/screenshots');
fs.mkdirSync(out, { recursive: true });
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];
const SAMPLE = path.resolve(import.meta.dirname, '../public/samples/birdnet-sample.wav');

const browser = await chromium.launch({ args: GL });
for (const theme of ['dark', 'light'] as const) {
  for (const signedIn of [true, false]) {
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await page.route(/\/v1\//, (route) => route.abort());
    await page.addInitScript(
      ({ t, member }) => {
        localStorage.setItem('birdbrain.theme.v1', t);
        try {
          const raw = localStorage.getItem('birdbrain.settings.v1');
          const s = raw ? JSON.parse(raw) : {};
          Object.assign(s, { locationMode: 'manual', manualLat: 47.36559, manualLon: 8.524997 });
          localStorage.setItem('birdbrain.settings.v1', JSON.stringify(s));
        } catch {
          /* ignore */
        }
        if (member) localStorage.setItem('birdbrain.auth.v1', JSON.stringify({ token: 'screenshot', expiresAt: null, user: { id: 'u1', email: 'member@example.com', name: 'member', status: 'approved', role: 'member' } }));
      },
      { t: theme, member: signedIn },
    );
    await page.goto(`${BASE}#/recordings`);
    await page.getByTestId('model-status').filter({ hasText: 'Model ready' }).waitFor({ timeout: 240_000 });
    await page.locator('#import-file').setInputFiles(SAMPLE);
    await page.waitForURL(/#\/recordings\/.+/, { timeout: 60_000 });
    await page.getByText(/Analysed \d+ windows/).waitFor({ timeout: 120_000 });
    // Give the Wikipedia summary, the article sections and the map tiles a moment.
    await page.waitForTimeout(6000);
    await page.evaluate(() => window.scrollTo(0, 0));
    const name = `sighting-card-${theme}-${signedIn ? 'signed-in' : 'signed-out'}.png`;
    await page.screenshot({ path: path.join(out, name), fullPage: true });
    console.log('done', name);
    await context.close();
  }
}
await browser.close();
