import { expect, test } from '@playwright/test';

/**
 * Loads the built app, waits for the BirdNET models to load inside the Web
 * Worker, then runs inference on the sample clip that ships with the official
 * BirdNET-Analyzer TF.js export (a redpoll) and checks the result.
 */
test('loads the model and identifies the bundled BirdNET sample clip', async ({ page, context }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Sabih’s Birdbrain' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Species' })).toBeVisible();

  const status = page.getByTestId('model-status');
  await expect(status, logs.join('\n')).toContainText('Model ready', { timeout: 200_000 });

  const demo = page.getByTestId('demo');
  await expect(demo).toBeEnabled();
  await demo.click();
  const results = page.getByTestId('results');
  await expect(results, logs.join('\n')).toContainText('Redpoll', { timeout: 120_000 });
  await expect(page.getByTestId('listen-status')).toContainText('Sample analysed');

  // Offline species browser works from the bundled label list.
  await page.getByRole('link', { name: 'Species' }).click();
  await page.getByRole('searchbox', { name: 'Search species' }).fill('redpoll');
  await expect(page.getByTestId('species-list')).toContainText('Lesser Redpoll');

  // The worker stores model files in the Cache API on first download.
  await page.waitForFunction(
    async () => {
      const c = await caches.open('birdnet-models-v2.4');
      return (await c.keys()).length >= 23;
    },
    null,
    { timeout: 60_000 },
  );
  // Service worker active and controlling the page after one online reload.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller != null, null, { timeout: 60_000 });
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 120_000 });

  // Fully offline: shell and model come from the caches.
  await context.setOffline(true);
  await page.goto('./#/listen');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sabih’s Birdbrain' })).toBeVisible();
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 120_000 });
  await page.getByTestId('demo').click();
  await expect(page.getByTestId('results')).toContainText('Redpoll', { timeout: 120_000 });
  await page.goto('./#/species');
  await page.getByRole('searchbox', { name: 'Search species' }).fill('chickadee');
  await expect(page.getByTestId('species-list')).toContainText('Black-capped Chickadee');
  await context.setOffline(false);
});

test('tabs, settings and map render', async ({ page }) => {
  await page.goto('./#/settings');
  await expect(page.getByText('Location & season filter')).toBeVisible();
  await page.goto('./#/map');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
  await page.goto('./#/recordings');
  await expect(page.getByText('Import audio file')).toBeVisible();
});

test('WebAssembly backend fallback loads the model and runs inference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ backend: 'wasm' }));
  });
  await page.goto('./');
  const status = page.getByTestId('model-status');
  await expect(status).toContainText('Model ready · wasm', { timeout: 240_000 });
  await page.getByTestId('demo').click();
  await expect(page.getByTestId('results')).toContainText('Redpoll', { timeout: 180_000 });
});

test('imports a recording, analyses it and explains an identification', async ({ page }) => {
  await page.goto('./#/recordings');
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  await page.locator('#import-file').setInputFiles('public/samples/birdnet-sample.wav');
  await page.waitForURL(/#\/recordings\/.+/, { timeout: 60_000 });
  await expect(page.getByText(/Analysed \d+ windows/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('recording-detections')).toContainText('Redpoll');

  const why = page.getByRole('button', { name: /^Why Lesser Redpoll/ });
  await why.click();
  await expect(page.getByText(/baseline \d+%/)).toBeVisible({ timeout: 240_000 });

  // The recording shows up in the list with its species summary, and on the species page.
  await page.goto('./#/recordings');
  await expect(page.getByTestId('recordings-list')).toContainText('birdnet-sample');
  await expect(page.getByTestId('recordings-list')).toContainText('Lesser Redpoll');
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.locator('.kv')).toContainText('Count', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible();
});
