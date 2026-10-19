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
  await expect(page.getByTestId('voice-processing')).toContainText('Voice processing: unknown');
  await expect(page.getByLabel('Low-cut filter (150 Hz)')).toBeChecked();
  await page.goto('./#/listen');
  await expect(page.getByTestId('conditions')).toContainText('Conditions:');
  await expect(page.getByTestId('threshold-help')).toContainText('Lower catches faint or distant birds but adds false IDs.');
  await page.goto('./#/map');
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
  // Tile images must be able to send a Referer (OSM tile policy): no referrerpolicy attribute from Leaflet.
  const tile = page.locator('img.leaflet-tile').first();
  await expect(tile).toBeAttached();
  await expect(tile).not.toHaveAttribute('referrerpolicy', /./);
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

  // Free user: the member-only ID card is replaced by a sign-in note.
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.getByTestId('species-id-card-gate')).toContainText('Sign in to unlock the species ID card.');

  // The recording shows up in the list with its species summary, and on the species page.
  await page.goto('./#/recordings');
  await expect(page.getByTestId('recordings-list')).toContainText('birdnet-sample');
  await expect(page.getByTestId('recordings-list')).toContainText('Lesser Redpoll');
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.locator('.kv')).toContainText('Sightings', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Recordings' })).toBeVisible();
});

test('approved member (cached session, API unreachable) gets the ID card, a clip and the sighting history', async ({ page }) => {
  // Gating is decided from the cached session alone; the API is blocked so this also proves it works offline.
  await page.route(/\/v1\//, (route) => route.abort());
  await page.addInitScript(() => {
    // Re-runs on every navigation; the flag lets the test simulate a sign-out.
    if (sessionStorage.getItem('e2e-signed-out')) return;
    localStorage.setItem('birdbrain.auth.v1', JSON.stringify({ token: 'e2e', expiresAt: null, user: { id: 'u1', email: 'member@example.com', name: 'member', status: 'approved', role: 'member' } }));
  });
  await page.goto('./#/recordings');
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  await page.locator('#import-file').setInputFiles('public/samples/birdnet-sample.wav');
  await page.waitForURL(/#\/recordings\/.+/, { timeout: 60_000 });
  await expect(page.getByText(/Analysed \d+ windows/)).toBeVisible({ timeout: 120_000 });

  await page.goto('./#/species/Acanthis%20cabaret');
  const card = page.getByTestId('species-id-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('clip-play')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('clip-meta')).toContainText(/\d+% confidence · imported file/);
  await expect(card).toContainText('none with a position yet');

  await card.click();
  await page.waitForURL(/#\/species\/Acanthis%20cabaret\/history/);
  await expect(page.getByTestId('history-summary')).toContainText(/1 sighting \(1 analysed window\), 0 with a position/);
  await expect(page.getByTestId('history-list')).toContainText('No position recorded');
  await expect(page.getByTestId('history-map')).toBeHidden();

  // Sign-out hides the features but keeps the data.
  await page.evaluate(() => {
    sessionStorage.setItem('e2e-signed-out', '1');
    localStorage.removeItem('birdbrain.auth.v1');
  });
  await page.reload();
  await expect(page.getByTestId('history-gate')).toContainText('Sign in to unlock Sighting history.');
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.getByTestId('wiki')).toBeVisible();
  await expect(page.getByText('Your sightings')).toBeVisible();
  await expect(page.locator('dl.kv dd').first()).toHaveText('1 (1 analysed window)'); // the sighting is still there
});

