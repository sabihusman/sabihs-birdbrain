import { devices, expect, test } from '@playwright/test';

/**
 * Most tests below were written for the Consolidated layout. The app now opens in
 * Focus on first run (DECISIONS.md #63), so pages from the default fixture start in
 * Consolidated unless the test stored its own settings; the first-run test below
 * uses a fresh context to check the real default.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(returningVisitor);
});

/**
 * A phone that has used Birdbrain before: stored settings and the "model wanted" flag. Without
 * them a fresh context is a first visit and Listen shows the welcome layer instead of the model
 * (DECISIONS.md #68). Tests that open their own context and need the usual Listen screen add this.
 */
function returningVisitor(): void {
  if (!localStorage.getItem('birdbrain.settings.v1')) localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ listenLayout: 'consolidated' }));
  localStorage.setItem('birdbrain.model.v1', 'wanted');
}

/** Requests for model files (any host): the welcome layer must not cause any. `labels.json` is the species list, bundled with the app and loaded at startup by design. */
const MODEL_FILE = /\/models\/birdnet-v2\.4\/(?!labels\.json).*\.(bin|json)(\?|$)/;

test('first visit: the welcome layer shows before any download, the tabs work behind it, and a choice is remembered', async ({ browser }) => {
  // No service worker here: requests it handles never reach page.route(), and the model is fetched inside the Web Worker.
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const page = await context.newPage();
  let modelRequests = 0;
  await page.route(MODEL_FILE, (route) => {
    modelRequests++;
    return route.continue();
  });
  // Every text the Listen panel shows under its progress bar, in order (the download is quick from localhost).
  await page.addInitScript(() => {
    const seen: string[] = [];
    const values: number[] = [];
    (window as unknown as { __modelTexts: string[] }).__modelTexts = seen;
    (window as unknown as { __modelValues: number[] }).__modelValues = values;
    const record = () => {
      const t = document.querySelector('[data-testid="model-text"]')?.textContent ?? '';
      if (t && seen[seen.length - 1] !== t) seen.push(t);
      const v = Number(document.querySelector('[data-testid="model-progress"]')?.getAttribute('aria-valuenow') ?? 'NaN');
      if (!Number.isNaN(v) && values[values.length - 1] !== v) values.push(v);
    };
    document.addEventListener('DOMContentLoaded', () => new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true }));
  });
  await page.goto('./');
  const welcome = page.getByTestId('welcome');
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText('Birdbrain listens and tells you which birds are singing.');
  await expect(welcome).toContainText('it downloads a 78 MB bird model. Use Wi-Fi if you can.');
  await expect(welcome).toContainText('An account is optional.');
  await expect(page.getByTestId('welcome-start')).toHaveText('Start identifying');
  await expect(page.getByTestId('welcome-signin')).toHaveText('Sign in / Create account');
  await expect(page.getByTestId('start-stop')).toHaveCount(0); // the layer stands in for the whole screen
  await expect(page.getByTestId('model-status')).toHaveText('Model not loaded');
  // The one filled button is Start identifying; the welcome fits the phone width.
  const box = await page.getByTestId('welcome-start').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
  // The tabs keep working behind the layer, and the species list loads without the model.
  await page.getByRole('link', { name: 'Species' }).click();
  await page.getByRole('searchbox', { name: 'Search species' }).fill('redpoll');
  await expect(page.getByTestId('species-list')).toContainText('Lesser Redpoll');
  await page.getByRole('link', { name: 'Listen' }).click();
  await expect(welcome).toBeVisible();
  // Sign in / Create account: Settings opens on the Account card, still with no download.
  await page.getByTestId('welcome-signin').click();
  await expect(page).toHaveURL(/#\/settings\/account$/);
  await expect(page.getByTestId('account')).toBeVisible();
  await expect(page.getByTestId('account').getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(modelRequests, 'nothing downloaded before Start identifying').toBe(0);
  // Back on Listen the layer is still up (no settings were changed), and Start identifying takes it down.
  await page.goto('./#/listen');
  await expect(welcome).toBeVisible();
  await page.getByTestId('welcome-start').click();
  await expect(welcome).toHaveCount(0);
  await expect(page.locator('.listen')).toHaveAttribute('data-status', /loading|ready/);
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  expect(modelRequests).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem('birdbrain.model.v1'))).toBe('wanted');
  // The panel showed the download in MB and the plain-words preparing step, on a real progress bar (DECISIONS.md #70).
  const texts = await page.evaluate(() => (window as unknown as { __modelTexts: string[] }).__modelTexts);
  expect(texts.some((t) => /^Downloading \d+ MB of 78 MB$/.test(t)), texts.join(' | ')).toBe(true);
  expect(texts, texts.join(' | ')).toContain('Preparing the model on this phone…');
  expect(texts.every((t) => !/BirdNET \(|backend|Warming up/.test(t)), 'no worker jargon on the panel').toBe(true);
  // The bar only moves forward, also when the location model starts (DECISIONS.md #71).
  const values = await page.evaluate(() => (window as unknown as { __modelValues: number[] }).__modelValues);
  expect(values.every((v, i) => i === 0 || v >= values[i - 1]), values.join(',')).toBe(true);
  const bar = page.getByTestId('model-progress');
  await expect(bar).toHaveAttribute('role', 'progressbar');
  await expect(bar).toHaveAttribute('aria-valuenow', '100');
  await expect(bar).toBeHidden(); // nothing left to show once the model is ready
  // A returning visitor never sees the layer again.
  await page.reload();
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await context.close();
});

test('the model loads only when needed: every tab and Account work with model requests aborted, and the sample clip starts the load', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const page = await context.newPage();
  // Settings stored, no flag, no cache: a returning visitor who never identified a bird (DECISIONS.md #69).
  // A manual position, so the Species tab's note is about the model and not about the missing GPS.
  await page.addInitScript(() => localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ listenLayout: 'consolidated', locationMode: 'manual', manualLat: 47.36559, manualLon: 8.524997 })));
  let modelRequests = 0;
  let allowModel = false;
  await page.route(MODEL_FILE, (route) => {
    modelRequests++;
    return allowModel ? route.continue() : route.abort();
  });
  await page.route(/\/v1\//, (route) => route.abort());
  await page.route(/\/v1\/auth\/login$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ challenge: 'c1', expiresInSeconds: 600 }) }));

  // Settings › Account: the sign-in form is reachable and usable.
  await page.goto('./#/settings');
  await expect(page.getByTestId('model-status')).toHaveText('Model not loaded');
  const account = page.getByTestId('account');
  await account.getByLabel('Email').fill('new@example.com');
  await account.getByLabel('Password').fill('correct horse battery staple');
  await account.getByRole('button', { name: 'Sign in' }).click();
  await expect(account).toContainText('We emailed a code to new@example.com');
  // Species (bundled list), Map and Recordings all render without the model.
  await page.goto('./#/species');
  await expect(page.getByTestId('local-note')).toContainText('needs the bird model');
  await page.getByRole('searchbox', { name: 'Search species' }).fill('redpoll');
  await expect(page.getByTestId('species-list')).toContainText('Lesser Redpoll');
  await page.goto('./#/map');
  await expect(page.getByTestId('map')).toBeVisible();
  await page.goto('./#/recordings');
  await expect(page.getByText('Import audio file')).toBeVisible();
  // Listen: no welcome (settings are stored), the controls are there, and still nothing was requested.
  await page.goto('./#/listen');
  await expect(page.getByTestId('welcome')).toHaveCount(0);
  await expect(page.locator('.listen')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByTestId('model-status')).toHaveText('Model not loaded');
  await expect(page.getByTestId('start-stop')).toBeEnabled();
  await expect(page.getByTestId('demo')).toBeEnabled();
  expect(modelRequests, 'no model request before an identifying action').toBe(0);

  // The sample clip is an identifying action: it loads the model, then analyses.
  allowModel = true;
  await page.getByTestId('demo').click();
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  expect(modelRequests).toBeGreaterThan(0);
  await expect(page.getByTestId('results')).toContainText('Redpoll', { timeout: 120_000 });
  expect(await page.evaluate(() => localStorage.getItem('birdbrain.model.v1'))).toBe('wanted');
  // Next visit: the flag makes the model load at startup, so the phone is "Model ready" without a tap.
  await page.reload();
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  await context.close();
});

test('first run opens Listen in Focus, and a chosen layout is kept after a reload', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.goto('./#/listen');
  await expect(page.locator('.listen')).toHaveAttribute('data-layout', 'focus');
  await page.goto('./#/settings');
  await page.getByTestId('listen-layout-dock').click();
  await page.goto('./#/listen');
  await page.reload();
  await expect(page.locator('.listen')).toHaveAttribute('data-layout', 'dock');
  await context.close();
});

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
  // Offline: the model still loads from the cache; the pill says so (DESIGN_GUIDE.md §7).
  await expect(page.getByTestId('model-status')).toContainText(/Offline|Model ready/, { timeout: 120_000 });
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
  await expect(page.getByTestId('threshold-help')).toContainText('Lower catches faint or distant birds but adds false IDs.');
  await page.goto('./#/listen');
  await expect(page.getByTestId('pipeline')).not.toHaveAttribute('open', /.*/);
  await expect(page.getByTestId('context-chips')).toContainText('Min. 60%');
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

/** Located sightings written straight into the app's IndexedDB (DECISIONS.md #72, #73 tests). */
const MAP_SIGHTINGS = (now: number) => [
  { id: 'm1', scientific: 'Poecile atricapillus', common: 'Black-capped Chickadee', lat: 41.7001, lon: -93.7002, t: now - 3_600_000 },
  { id: 'm2', scientific: 'Euphagus carolinus', common: 'Rusty Blackbird', lat: 41.7012, lon: -93.6991, t: now - 2 * 3_600_000 },
  { id: 'm3', scientific: 'Poecile atricapillus', common: 'Black-capped Chickadee', lat: 41.7203, lon: -93.7198, t: now - 3 * 3_600_000 },
  { id: 'm4', scientific: 'Dryobates villosus', common: 'Hairy Woodpecker', lat: 41.8, lon: -93.6, t: now - 4 * 86_400_000 },
];

/** With `withRecording`, the newest chickadee (m1) also has a saved recording, `rec-m1` (DECISIONS.md #75). */
async function seedSightings(page: import('@playwright/test').Page, withRecording = false): Promise<void> {
  // The app creates the database on start; wait for it, then add rows without changing its version.
  await expect.poll(() => page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'sabihs-birdbrain'))).toBe(true);
  const rows = MAP_SIGHTINGS(Date.now()).map((s) => ({ id: s.id, label: `${s.scientific}_${s.common}`, scientific: s.scientific, common: s.common, firstTime: s.t, lastTime: s.t, peakConfidence: 0.8, hits: 2, lat: s.lat, lon: s.lon, accuracy: 10, fixTime: s.t, recordingId: withRecording && s.id === 'm1' ? 'rec-m1' : null, offsetSec: withRecording && s.id === 'm1' ? 0 : null, source: 'live', sessionId: 'e2e', peakDetectionId: `d-${s.id}` }));
  const m1 = MAP_SIGHTINGS(Date.now())[0];
  await page.evaluate(
    ([rs, rec]) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('sabihs-birdbrain');
        req.onsuccess = () => {
          const tx = req.result.transaction(rec ? ['sightings', 'recordings'] : ['sightings'], 'readwrite');
          for (const r of rs) tx.objectStore('sightings').put(r);
          if (rec) tx.objectStore('recordings').put({ ...rec, blob: new Blob([new Uint8Array(44)], { type: 'audio/wav' }) });
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    [rows, withRecording ? { id: 'rec-m1', createdAt: m1.t, name: 'E2E clip', durationSec: 3, sampleRate: 48000, bytes: 44, source: 'mic', lat: m1.lat, lon: m1.lon, accuracy: 10, fixTime: m1.t, summary: [], analyzedAt: null } : null] as const,
  );
}

const NOMINATIM = /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/;

/**
 * Stub for Nominatim reverse (DECISIONS.md #73), in the jsonv2 shape seen live. The seeded sightings
 * make three areas, centred (oldest sighting first) on 41.800,-93.600, 41.720,-93.720 and
 * 41.701,-93.699 (m1 is 150 m from m2, so they share one): a park, a road, and nothing.
 */
function nominatimFixture(url: string): unknown {
  const q = new URL(url).searchParams;
  const at = `${q.get('lat')},${q.get('lon')}`;
  if (at === '41.701,-93.699') return { category: 'leisure', type: 'park', name: 'Prairie Test Park', display_name: 'Prairie Test Park, Johnston, Polk County, Iowa, United States', address: { leisure: 'Prairie Test Park', town: 'Johnston', county: 'Polk County', state: 'Iowa', country: 'United States' } };
  if (at === '41.720,-93.720') return { category: 'highway', type: 'residential', name: 'Creek Test Road', address: { road: 'Creek Test Road', town: 'Johnston', state: 'Iowa' } };
  return { error: 'Unable to geocode' };
}

test('Map tab: no filter card; Birds and Places (1 km areas) cards under the map, tap zooms and fades, Show all, Nominatim only for Places, 320 px in both themes', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.addInitScript(returningVisitor);
  // No real network for photos or places in this test.
  await page.route(/wikipedia\.org|wikimedia\.org/, (route) => route.abort());
  const geocodeCalls: Array<{ url: string; at: number }> = [];
  await page.route(NOMINATIM, async (route) => {
    const req = route.request();
    geocodeCalls.push({ url: req.url(), at: Date.now() });
    expect(req.method()).toBe('GET');
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(nominatimFixture(req.url())) });
  });
  await page.goto('./#/settings');
  await seedSightings(page);
  await page.goto('./#/map');
  await expect(page.getByTestId('map')).toBeVisible();
  // The old Species / From / To filter card is gone.
  await expect(page.getByLabel('Filter by species')).toHaveCount(0);
  await expect(page.getByLabel('From date')).toHaveCount(0);
  await expect(page.getByText(/located sightings shown/)).toHaveCount(0);

  // Birds view (the default): one card per species, newest first.
  const tabs = page.getByRole('tablist', { name: 'Cards under the map' });
  await expect(tabs.getByRole('tab', { name: 'Birds' })).toHaveAttribute('aria-selected', 'true');
  const birdCards = page.getByTestId('map-bird-card');
  await expect(birdCards).toHaveCount(3);
  expect(await birdCards.evaluateAll((els) => els.map((e) => e.getAttribute('data-species')))).toEqual(['Poecile atricapillus', 'Euphagus carolinus', 'Dryobates villosus']);
  await expect(birdCards.first()).toContainText('Black-capped Chickadee');
  await expect(birdCards.first()).toContainText(/2 sightings · last /);
  await expect(birdCards.nth(1)).toContainText(/1 sighting · /);
  await expect(page.getByTestId('map-count')).toHaveText('3 species · 4 sightings with a location');
  for (const box of await Promise.all((await birdCards.all()).map((c) => c.boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(geocodeCalls, 'nothing goes to Nominatim from the Birds view').toHaveLength(0);

  // Tap a bird: map zooms to its sightings, the others fade, its sightings become photo pins, nothing opens (#75).
  await page.getByTestId('map-bird-card').filter({ hasText: 'Black-capped Chickadee' }).click();
  await expect(page.getByTestId('map')).toHaveAttribute('data-focus', 'bird:Poecile atricapillus');
  await expect(page.getByTestId('map-bird-pin')).toHaveCount(2);
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);
  await expect(page.getByTestId('map-count')).toContainText('Showing Black-capped Chickadee · Show all');
  await expect(page.getByTestId('map-bird-card').first()).toHaveAttribute('aria-pressed', 'true');
  // Show all resets.
  await page.getByTestId('map-show-all').click();
  await expect(page.getByTestId('map')).not.toHaveAttribute('data-focus', /./);
  await expect(page.getByTestId('map-bird-pin')).toHaveCount(0);
  await expect(page.getByTestId('map-count')).toHaveText('3 species · 4 sightings with a location');
  // Tap twice: the species page.
  const rusty = page.getByTestId('map-bird-card').filter({ hasText: 'Rusty Blackbird' });
  await rusty.click();
  await expect(page.getByTestId('map')).toHaveAttribute('data-focus', 'bird:Euphagus carolinus');
  await page.getByTestId('map-bird-card').filter({ hasText: 'Rusty Blackbird' }).click();
  await expect(page).toHaveURL(/#\/species\/Euphagus%20carolinus$/);
  expect(geocodeCalls).toHaveLength(0);

  // Places view: three areas at once (coordinates first), then a name per area, one request at a time.
  await page.goto('./#/map');
  await page.getByRole('tab', { name: 'Places' }).click();
  const placeCards = page.getByTestId('map-place-card');
  await expect(placeCards).toHaveCount(3);
  expect(await placeCards.evaluateAll((els) => els.map((e) => e.getAttribute('data-place')))).toEqual(['41.701,-93.699', '41.720,-93.720', '41.800,-93.600']);
  await expect(page.getByTestId('map-count')).toHaveText('3 areas · each about 1 km across');
  await expect(placeCards.nth(0)).toContainText('Prairie Test Park', { timeout: 15_000 });
  await expect(placeCards.nth(1)).toContainText('Creek Test Road', { timeout: 15_000 });
  await expect(placeCards.nth(2)).toHaveAttribute('data-named', 'false');
  await expect(page.getByTestId('map-place-looking')).toHaveCount(0, { timeout: 15_000 });
  await expect(placeCards.nth(0)).toContainText('Johnston, Iowa');
  await expect(placeCards.nth(0)).toContainText('2 sightings · 2 species');
  await expect(placeCards.nth(0).locator('.map-pill')).toHaveCount(2);
  await expect(placeCards.nth(1)).toContainText('1 sighting · 1 species');
  // Nominatim had no name: the area still lists, with its coordinates.
  await expect(placeCards.nth(2)).toContainText('Near 41.800, −93.600');
  await expect(page.getByText('Other spots')).toHaveCount(0);
  await expect(page.getByTestId('map-places-status')).toBeHidden();
  await expect(page.getByTestId('places-credit')).toContainText('Place names: © OpenStreetMap contributors');
  // Only the rounded centres, 1.1 s apart.
  expect(geocodeCalls).toHaveLength(3);
  for (const c of geocodeCalls) expect(c.url).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/reverse\?format=jsonv2&lat=-?\d+\.\d{3}&lon=-?\d+\.\d{3}&zoom=17&addressdetails=1$/);
  for (let i = 1; i < geocodeCalls.length; i++) expect(geocodeCalls[i].at - geocodeCalls[i - 1].at).toBeGreaterThanOrEqual(1000);
  // Tap an area: the map fits it, the dashed 1 km circle, the others faded.
  await placeCards.nth(0).click();
  await expect(page.getByTestId('map')).toHaveAttribute('data-focus', 'place:41.701,-93.699');
  await expect(page.locator('.map-marker-selected')).toHaveCount(2);
  await expect(page.locator('path.place-outline')).toHaveCount(1);
  await expect(page.locator('path.place-outline')).toHaveAttribute('stroke-dasharray', '6 5');
  await expect(page.getByTestId('map-count')).toContainText('Showing Prairie Test Park · Show all');
  // The choice is remembered, and a second visit uses the cache (no new request).
  await page.goto('./#/listen');
  await page.goto('./#/map');
  await expect(page.getByRole('tab', { name: 'Places' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('map-place-card').first()).toContainText('Prairie Test Park');
  await expect(page.getByTestId('map-place-card')).toHaveCount(3);
  expect(geocodeCalls).toHaveLength(3);
  await context.close();

  // Busy server while online: the areas still list with their coordinates, a plain line and a Retry.
  const busyCtx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const busy = await busyCtx.newPage();
  await busy.addInitScript(returningVisitor);
  await busy.route(/wikipedia\.org|wikimedia\.org/, (route) => route.abort());
  let busyCalls = 0;
  await busy.route(NOMINATIM, (route) => {
    busyCalls++;
    return route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
  });
  await busy.goto('./#/settings');
  await seedSightings(busy);
  await busy.goto('./#/map');
  await busy.getByRole('tab', { name: 'Places' }).click();
  await expect(busy.getByTestId('map-places-status')).toContainText('Place names are busy, try again later.');
  await expect(busy.getByTestId('map-places-status')).not.toContainText('need a connection');
  await expect(busy.getByTestId('map-places-retry')).toBeVisible();
  await expect(busy.getByTestId('map-place-card')).toHaveCount(3);
  await expect(busy.getByTestId('map-place-card').first()).toContainText('Near 41.701, −93.699');
  expect(busyCalls, 'the queue stops at the first failure').toBe(1);
  await busyCtx.setOffline(true);
  await busy.getByRole('tab', { name: 'Birds' }).click();
  await expect(busy.getByTestId('map-bird-card')).toHaveCount(3);
  await busyCtx.close();

  // Offline (navigator.onLine false): the connection line, nothing sent, the areas still listed.
  const offCtx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const off = await offCtx.newPage();
  await off.addInitScript(returningVisitor);
  await off.route(/wikipedia\.org|wikimedia\.org|tile\.openstreetmap\.org/, (route) => route.abort());
  let offCalls = 0;
  await off.route(NOMINATIM, (route) => {
    offCalls++;
    return route.abort();
  });
  await off.goto('./#/settings');
  await seedSightings(off);
  await offCtx.setOffline(true);
  await off.goto('./#/map');
  await off.getByRole('tab', { name: 'Places' }).click();
  await expect(off.getByTestId('map-places-status')).toContainText('Place names need a connection.');
  await expect(off.getByTestId('map-place-card')).toHaveCount(3);
  expect(offCalls).toBe(0);
  await offCtx.close();

  // 320 px, both themes: nothing wider than the screen in either view.
  const narrow = await browser.newContext({ viewport: { width: 320, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const np = await narrow.newPage();
  await np.addInitScript(returningVisitor);
  await np.route(/wikipedia\.org|wikimedia\.org/, (route) => route.abort());
  await np.route(NOMINATIM, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(nominatimFixture(route.request().url())) }));
  await np.goto('./#/settings');
  await seedSightings(np);
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await np.getByTestId('theme-toggle').click();
    expect(await np.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
    await np.goto('./#/map');
    for (const v of ['Birds', 'Places']) {
      await np.getByRole('tab', { name: v }).click();
      await expect(np.getByTestId(v === 'Birds' ? 'map-bird-card' : 'map-place-card').first()).toBeVisible();
      if (v === 'Places') await expect(np.getByTestId('map-place-card').first()).toContainText('Prairie Test Park', { timeout: 15_000 });
      const widths = await np.evaluate(() => ({
        view: document.querySelector('main.view')!.scrollWidth,
        right: Math.max(...[...document.querySelectorAll('[data-testid="map-bird-card"], [data-testid="map-place-card"], [data-testid="map-cards-switch"]')].map((c) => c.getBoundingClientRect().right)),
      }));
      expect(widths.view, `${theme} ${v} view at 320px`).toBeLessThanOrEqual(320);
      expect(widths.right, `${theme} ${v} cards at 320px`).toBeLessThanOrEqual(320);
    }
    await np.goto('./#/settings');
  }
  await narrow.close();
});

/**
 * Height of the old details popup (bird card tap → the newest sighting's full popup) on the Map tab
 * at 375 × 812, measured on main at 3a4e07e before #75 with these seeded sightings (dark theme):
 * 303 px, already capped by its maxHeight (map height − 90). The compact card must stay ≤ 55 % of it.
 */
const OLD_MAP_POPUP_PX = 303;

/** Leaflet auto-pans (animated) to bring an opened card inside the map; wait until it is fully inside. */
async function waitForCardInsideMap(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const m = (await page.getByTestId('map').boundingBox())!;
        const c = await page.locator('.leaflet-popup.compact-popup').boundingBox();
        return !!c && c.x >= m.x && c.y >= m.y && c.x + c.width <= m.x + m.width;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
}

test('Map tab photo pins: a bird card shows round photo pins and no popup; a pin opens the compact card; Details, Show all, dot tap, 320 px in both themes (DECISIONS.md #75)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.addInitScript(returningVisitor);
  await page.route(/wikipedia\.org|wikimedia\.org|tile\.openstreetmap\.org|nominatim\.openstreetmap\.org/, (route) => route.abort());
  await page.goto('./#/settings');
  await seedSightings(page, true);
  await page.goto('./#/map');
  await expect(page.getByTestId('map-bird-card')).toHaveCount(3);
  // Show all: plain dots only.
  await expect(page.getByTestId('map-bird-pin')).toHaveCount(0);

  // Card tap: one photo pin per located sighting of that bird, the newest larger, no popup, the hint for 4 s.
  await page.getByTestId('map-bird-card').filter({ hasText: 'Black-capped Chickadee' }).click();
  const pins = page.getByTestId('map-bird-pin');
  await expect(pins).toHaveCount(2);
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);
  await expect(page.getByTestId('map-hint')).toHaveText('Tap the bird for details');
  await expect(page.getByTestId('map-hint')).toHaveAttribute('aria-live', 'polite');
  const newest = page.locator('[data-testid="map-bird-pin"][data-newest="true"]');
  await expect(newest).toHaveCount(1);
  await expect(newest).toHaveAttribute('data-sighting', 'm1');
  await expect(newest).toHaveAttribute('role', 'button');
  await expect(newest).toHaveAttribute('tabindex', '0');
  await expect(newest).toHaveAttribute('aria-label', /^Black-capped Chickadee, .+\. Show details$/);
  const sizes = await pins.evaluateAll((els) => els.map((e) => ({ id: (e as HTMLElement).dataset.sighting, w: e.querySelector('.bird-pin')!.getBoundingClientRect().width })));
  expect(sizes.find((p) => p.id === 'm1')!.w).toBeCloseTo(52, 1);
  expect(sizes.find((p) => p.id === 'm3')!.w).toBeCloseTo(40, 1);
  // The ring is the species colour, set through the CSSOM (no style attribute is allowed by the CSP).
  const ring = await newest.evaluate((e) => ({ border: getComputedStyle(e.querySelector('.bird-pin')!).borderTopColor, styleAttr: e.querySelector('.bird-pin')!.getAttribute('style') }));
  expect(ring.border).toMatch(/^rgb\(/);
  expect(ring.styleAttr ?? '').toContain('--ring');
  // The photo slot shows the bird outline while Wikipedia is unreachable.
  await expect(newest.locator('.bird-pin-photo.placeholder')).toHaveCount(1);
  await expect(page.getByTestId('map-hint')).toHaveText('', { timeout: 6_000 });

  // Pin tap: the compact card, at most 55 % of the old popup's height.
  await newest.click();
  const card = page.getByTestId('compact-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Black-capped Chickadee');
  await expect(card).toContainText(/ · \d{1,2}:\d{2}\s?[AP]M · 80%/);
  await expect(card).toContainText('41.70010, −93.70020 · ±10 m');
  for (const id of ['compact-copy', 'compact-maps', 'compact-details']) {
    const box = await page.getByTestId(id).boundingBox();
    // 44 px, less sub-pixel rounding from the map pane's transform.
    expect(box!.height, id).toBeGreaterThanOrEqual(43.5);
  }
  await expect(page.getByTestId('compact-maps')).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=41\.700100%2C-93\.700200$/);
  await expect(page.getByTestId('compact-details')).toHaveAttribute('href', '#/recordings/rec-m1');
  const mapBox = (await page.getByTestId('map').boundingBox())!;
  await waitForCardInsideMap(page);
  const popupBox = (await page.locator('.leaflet-popup.compact-popup').boundingBox())!;
  console.log(`compact card ${popupBox.height.toFixed(1)} px vs old popup ${OLD_MAP_POPUP_PX} px (${((popupBox.height / OLD_MAP_POPUP_PX) * 100).toFixed(0)} %)`);
  expect(popupBox.height).toBeLessThanOrEqual(OLD_MAP_POPUP_PX * 0.55);
  expect(popupBox.y).toBeGreaterThanOrEqual(mapBox.y);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(mapBox.x + mapBox.width);
  // × closes it; the pin stays.
  await page.locator('.compact-popup .leaflet-popup-close-button').click();
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);
  await expect(pins).toHaveCount(2);
  // Keyboard: Enter on a focused pin opens the card.
  await newest.focus();
  await page.keyboard.press('Enter');
  await expect(card).toBeVisible();
  await page.locator('.compact-popup .leaflet-popup-close-button').click();
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);
  // The older sighting has no recording: Details falls back to the species page.
  await page.locator('[data-testid="map-bird-pin"][data-sighting="m3"]').click();
  await expect(page.getByTestId('compact-card')).toHaveAttribute('data-sighting', 'm3');
  await expect(page.getByTestId('compact-details')).toHaveAttribute('href', '#/species/Poecile%20atricapillus');

  // Show all: plain dots again, no card.
  await page.getByTestId('map-show-all').click();
  await expect(pins).toHaveCount(0);
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);

  // A plain dot tapped: that bird is chosen (photo pins, others faded) and the tapped sighting's card opens.
  // After Show all, the unclustered sightings are plain SVG dots (clusters are div icons).
  const dot = page.locator('path.leaflet-interactive').first();
  await expect(dot).toBeAttached();
  await dot.click();
  await expect(page.getByTestId('map')).toHaveAttribute('data-focus', /^bird:/);
  const chosen = (await page.getByTestId('map').getAttribute('data-focus'))!.slice(5);
  await expect(page.getByTestId('compact-card')).toBeVisible();
  await expect(page.getByTestId('map-bird-card').first()).toHaveAttribute('data-species', chosen);
  await expect(page.getByTestId('map-bird-card').first()).toHaveAttribute('aria-pressed', 'true');
  expect(await pins.count()).toBeGreaterThan(0);
  await context.close();

  // Details on a sighting with a recording opens its sighting card in Recordings.
  const ctx2 = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(returningVisitor);
  await p2.route(/wikipedia\.org|wikimedia\.org|tile\.openstreetmap\.org/, (route) => route.abort());
  await p2.goto('./#/settings');
  await seedSightings(p2, true);
  await p2.goto('./#/map');
  await p2.getByTestId('map-bird-card').filter({ hasText: 'Black-capped Chickadee' }).click();
  await p2.locator('[data-testid="map-bird-pin"][data-newest="true"]').click();
  await p2.getByTestId('compact-details').click();
  await expect(p2).toHaveURL(/#\/recordings\/rec-m1$/);
  await expect(p2.getByText('E2E clip', { exact: false })).toBeVisible();
  await ctx2.close();

  // 320 px, both themes: the pins and the card fit inside the map, the actions keep 44 px.
  const narrow = await browser.newContext({ viewport: { width: 320, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const np = await narrow.newPage();
  await np.addInitScript(returningVisitor);
  await np.route(/wikipedia\.org|wikimedia\.org|tile\.openstreetmap\.org/, (route) => route.abort());
  await np.goto('./#/settings');
  await seedSightings(np, true);
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await np.getByTestId('theme-toggle').click();
    expect(await np.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
    await np.goto('./#/map');
    await np.getByTestId('map-bird-card').filter({ hasText: 'Black-capped Chickadee' }).click();
    await expect(np.getByTestId('map-bird-pin')).toHaveCount(2);
    await np.locator('[data-testid="map-bird-pin"][data-newest="true"]').click();
    await expect(np.getByTestId('compact-card')).toBeVisible();
    const m = (await np.getByTestId('map').boundingBox())!;
    await waitForCardInsideMap(np);
    const c = (await np.locator('.leaflet-popup.compact-popup').boundingBox())!;
    expect(c.x, `${theme} card left`).toBeGreaterThanOrEqual(m.x);
    expect(c.x + c.width, `${theme} card right`).toBeLessThanOrEqual(m.x + m.width);
    expect(c.y, `${theme} card top`).toBeGreaterThanOrEqual(m.y);
    for (const id of ['compact-copy', 'compact-maps', 'compact-details']) expect((await np.getByTestId(id).boundingBox())!.height, `${theme} ${id}`).toBeGreaterThanOrEqual(43.5);
    const colors = await np.getByTestId('compact-card').evaluate((e) => ({ bg: getComputedStyle(e.closest('.leaflet-popup-content-wrapper')!).backgroundColor, text: getComputedStyle(e).color }));
    expect(colors.bg, `${theme} card background follows the theme`).not.toBe(colors.text);
    expect(await np.evaluate(() => document.querySelector('main.view')!.scrollWidth), `${theme} no horizontal scroll`).toBeLessThanOrEqual(320);
    await np.goto('./#/settings');
  }
  await narrow.close();
});

test('WebAssembly backend fallback loads the model and runs inference', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ backend: 'wasm', listenLayout: 'consolidated' }));
  });
  await page.goto('./');
  const status = page.getByTestId('model-status');
  await expect(status).toContainText('Model ready · wasm', { timeout: 240_000 });
  await page.getByTestId('demo').click();
  await expect(page.getByTestId('results')).toContainText('Redpoll', { timeout: 180_000 });
});

test('imports a recording, analyses it and explains an identification', async ({ page }) => {
  // A manual position so the sighting card has a location (headless Chromium has no GPS).
  await page.addInitScript(() => {
    const raw = localStorage.getItem('birdbrain.settings.v1');
    const s = raw ? JSON.parse(raw) : {};
    Object.assign(s, { locationMode: 'manual', manualLat: 47.36559, manualLon: 8.524997 });
    localStorage.setItem('birdbrain.settings.v1', JSON.stringify(s));
  });
  await page.goto('./#/recordings');
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  await page.locator('#import-file').setInputFiles('public/samples/birdnet-sample.wav');
  await page.waitForURL(/#\/recordings\/.+/, { timeout: 60_000 });
  await expect(page.getByText(/Analysed \d+ windows/)).toBeVisible({ timeout: 120_000 });
  // Every species row starts with a small bird photo (placeholder until Wikipedia answers).
  await expect(page.locator('.chip .chip-thumb').first()).toBeVisible();
  await expect(page.getByTestId('recording-detections')).toContainText('Redpoll');

  // Sighting card: the bird's names as the title, confidence as text, map preview above the coordinates,
  // Plus Code folded away, About this bird, and "Sign in to ask" for a free user.
  await expect(page.getByTestId('recording-title')).toHaveText('Lesser Redpoll');
  await expect(page.getByTestId('recording-sci')).toHaveText('Acanthis cabaret');
  await expect(page.getByTestId('confidence-line')).toHaveText(/^Confidence \d+% · your minimum 60%$/);
  await expect(page.locator('canvas.timeline')).toHaveCount(0);
  const location = page.getByTestId('sighting-location');
  await expect(location.getByTestId('map-preview')).toBeVisible();
  await expect(location.getByRole('button', { name: /Tap to explore/ })).toBeVisible();
  await expect(location.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
  await expect(location.locator('code').first()).toHaveText('47.36559, 8.52500');
  await expect(location.getByRole('link', { name: 'Open in Google Maps' })).toBeVisible();
  const more = location.getByTestId('location-more');
  await expect(more).not.toHaveAttribute('open', /.*/);
  await expect(more).not.toContainText('8FVC9G8F+6X', { useInnerText: true });
  await more.locator('summary').click();
  await expect(more).toContainText('8FVC9G8F+6X');
  await expect(more).toContainText("Google's short code for this spot; works in Google Maps.");
  await location.getByRole('button', { name: /Tap to explore/ }).click();
  await expect(location.locator('.leaflet-control-zoom')).toBeVisible();
  await expect(page.getByTestId('about-bird')).toContainText('About this bird');
  await expect(page.getByTestId('ask-box').getByTestId('ask-locked')).toContainText('Sign in to ask');

  const why = page.getByRole('button', { name: /^Why Lesser Redpoll/ });
  await why.click();
  // The result sits in the Spectrogram card and explains what the shading means (DECISIONS.md #62).
  await expect(page.getByTestId('spectrogram-card').getByTestId('why-explanation')).toContainText('How to read it', { timeout: 240_000 });

  // Free user: the member-only ID card is replaced by a sign-in note.
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.getByTestId('species-id-card-gate')).toContainText('Sign in to unlock the species ID card.');

  // Species tab: the spotted species carries a tick; "Spotted by me" narrows the list to it; the tick says "Sign in to unlock" (DECISIONS.md #41).
  await page.goto('./#/species');
  // The manual position set above narrows the list to local species; show all so the search can find the redpoll.
  await page.getByTestId('show-all-species').check();
  await page.getByRole('searchbox', { name: 'Search species' }).fill('redpoll');
  const redpollRow = page.getByTestId('spotted-row').filter({ hasText: 'Lesser Redpoll' });
  await expect(redpollRow).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search species' }).fill('');
  const spottedFilter = page.getByTestId('spotted-filter');
  await spottedFilter.click();
  await expect(spottedFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('local-count')).toContainText(/\d+ species spotted by you/);
  await expect(page.getByTestId('species-list')).toContainText('Lesser Redpoll');
  await expect(page.getByTestId('species-list').locator('.chip')).toHaveCount(await page.getByTestId('spotted-tick').count());
  await redpollRow.getByTestId('spotted-tick').click();
  await expect(redpollRow).toContainText('Sign in to unlock the species ID card.');
  await expect(page).toHaveURL(/#\/species$/);

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
  // Members get the Ask box on the sighting card itself.
  await expect(page.getByTestId('recording-title')).toHaveText('Lesser Redpoll');
  await expect(page.getByTestId('ask-box').getByLabel('Your question')).toBeVisible();
  await expect(page.getByTestId('ask-box').getByTestId('ask-locked')).toHaveCount(0);
  await expect(page.getByTestId('sighting-location')).toHaveCount(0); // no position in this test

  // The tick on the Species tab opens this species' ID card for a member (DECISIONS.md #41).
  await page.goto('./#/species');
  await page.getByTestId('spotted-filter').click();
  await page.getByTestId('spotted-row').filter({ hasText: 'Lesser Redpoll' }).getByTestId('spotted-tick').click();
  await page.waitForURL(/#\/species\/Acanthis%20cabaret$/);
  const card = page.getByTestId('species-id-card');
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(card.getByTestId('clip-play')).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('clip-meta')).toContainText(/\d+% confidence · imported file/);
  await expect(card).toContainText('none with a position yet');

  // ID clip: spectrogram drawn from the stored audio, the identifying window listed with its confidence, the wording, and tap-to-run "Why this ID".
  await expect(card.getByTestId('clip-spectrogram')).toBeVisible();
  await expect(card.getByTestId('clip-windows')).toContainText(/Identified in 1 window of 3 s: 0:00–0:03 \(\d+%\)/);
  await expect(card.getByTestId('clip-meaning')).toContainText('BirdNET marks when a species is heard, not which of the overlapping sounds it is.');
  await expect(card.getByTestId('clip-why-result')).toHaveCount(0); // nothing ran on its own
  // Tapping the spectrogram seeks; it must not open the history (the card is a link).
  await card.locator('.viz canvas.overlay').click({ position: { x: 40, y: 40 } });
  await expect(page).toHaveURL(/#\/species\/Acanthis%20cabaret$/);
  await card.getByTestId('clip-why-run').click();
  await expect(card.getByTestId('clip-why-result')).toContainText(/Lesser Redpoll: baseline \d+% on this window/, { timeout: 240_000 });

  // Tap the card's own text (the spectrogram at the card's centre seeks instead; the header row sits under the sticky app header after the tick's scroll).
  await card.getByText('none with a position yet').click();
  await page.waitForURL(/#\/species\/Acanthis%20cabaret\/history/);
  await expect(page.getByTestId('history-summary')).toContainText(/1 sighting \(1 analysed window\), 0 with a position/);
  await expect(page.getByTestId('history-list')).toContainText('No position recorded');
  await expect(page.getByTestId('history-map')).toBeHidden();

  // Account card for a member: grouped rows, long text behind collapsed rows, deleting on its own
  // screen (DECISIONS.md #43, #57).
  await page.goto('./#/settings');
  await expect(page.getByTestId('account-name')).toHaveText('member');
  await expect(page.getByTestId('account-email')).toHaveText('member@example.com');
  await expect(page.getByTestId('account-role')).toHaveText('Member');
  await expect(page.getByTestId('share-species')).not.toBeChecked();
  await expect(page.getByTestId('share-status')).toContainText('Sharing is off');
  // The consent text and the invite form sit behind the Friends row until it is opened.
  await expect(page.getByTestId('invite-send')).toBeHidden();
  await page.getByTestId('friends-fold').getByText('Friends and invites').click();
  await expect(page.getByTestId('share-consent')).toContainText('which birds you’ve spotted and the date you last spotted each one');
  await expect(page.getByTestId('invite-send')).toBeVisible();
  // "What we store" is the last thing on Settings, closed, with every fact inside.
  const wws = page.getByTestId('what-we-store');
  await expect(wws).not.toHaveAttribute('open', /.*/);
  await expect(wws).toContainText('Sightings stay on your phone');
  await wws.getByText('What we store').click();
  await expect(wws).toContainText('Only on this phone');
  await expect(wws).toContainText('Copies in the nightly server backup are removed within 14 days.');
  // Delete: the row opens its own screen, and the button stays disabled until the password and the
  // word are typed; a wrong word does nothing.
  await expect(page.getByTestId('delete-password')).toHaveCount(0);
  await page.getByTestId('delete-row').click();
  await expect(page.getByTestId('delete-screen')).toBeVisible();
  await expect(page.getByTestId('delete-account')).toBeDisabled();
  await page.getByTestId('delete-password').fill('correct horse battery staple');
  await expect(page.getByTestId('delete-account')).toBeDisabled();
  await page.getByTestId('delete-word').fill('delete');
  await expect(page.getByTestId('delete-account')).toBeEnabled();
  await page.getByTestId('delete-account').click();
  await expect(page.getByTestId('account')).toContainText('Type DELETE in capitals to confirm. Your account was not deleted.');
  await expect(page.getByTestId('account-deleted')).toHaveCount(0);
  await page.getByTestId('delete-cancel').click();
  await expect(page.getByTestId('account-name')).toHaveText('member');
  // The species page shows the "Spotted by" card with the member's own row (friends unreachable: only "You").
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.getByTestId('spotted-by-me')).toContainText(/You · /);
  await expect(page.getByTestId('spotted-by-friend')).toHaveCount(0);
  await expect(page.getByTestId('friends-filter')).toBeHidden(); // not on the species page
  await page.goto('./#/species');
  await expect(page.getByTestId('friends-filter')).toBeVisible();
  await page.goto('./#/species/Acanthis%20cabaret/history');
  await expect(page.getByTestId('history-summary')).toBeVisible();

  // Sign-out hides the features but keeps the data.
  await page.evaluate(() => {
    sessionStorage.setItem('e2e-signed-out', '1');
    localStorage.removeItem('birdbrain.auth.v1');
  });
  await page.reload();
  await expect(page.getByTestId('history-gate')).toContainText('Sign in to unlock Sighting history.');
  await page.goto('./#/species');
  await expect(page.getByTestId('friends-filter')).toBeHidden();
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.getByTestId('wiki')).toBeVisible();
  await expect(page.getByText('Your sightings')).toBeVisible();
  await expect(page.locator('dl.kv dd').first()).toHaveText('1 (1 analysed window)'); // the sighting is still there

  // Deletion with the API stubbed: the right password and word show the confirmation screen, signed out,
  // with "Also clear sightings saved on this phone" unchecked; Done keeps the sighting.
  let deleteBody: unknown = null;
  await page.route(/\/v1\/me\/delete$/, async (route) => {
    deleteBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.evaluate(() => {
    localStorage.setItem('birdbrain.auth.v1', JSON.stringify({ token: 'e2e', expiresAt: null, user: { id: 'u1', email: 'member@example.com', name: 'member', status: 'approved', role: 'member' } }));
  });
  await page.goto('./#/settings');
  await page.reload();
  await expect(page.getByTestId('account-name')).toHaveText('member');
  await page.getByTestId('delete-row').click();
  await page.getByTestId('delete-password').fill('correct horse battery staple');
  await page.getByTestId('delete-word').fill('DELETE');
  await page.getByTestId('delete-account').click();
  await expect(page.getByTestId('account-deleted')).toBeVisible();
  await expect(page.getByTestId('account-deleted')).toContainText('Your account was deleted.');
  expect(deleteBody).toEqual({ password: 'correct horse battery staple', confirm: 'DELETE' });
  await expect(page.getByTestId('wipe-phone')).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('birdbrain.auth.v1'))).toBeNull();
  await page.getByTestId('deleted-done').click();
  await expect(page.getByTestId('account-deleted')).toHaveCount(0);
  await expect(page.getByTestId('account').getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.goto('./#/species/Acanthis%20cabaret');
  await expect(page.locator('dl.kv dd').first()).toHaveText('1 (1 analysed window)'); // kept: the box was unchecked
});

test('theme: dark by default whatever the device prefers, toggle persists, no wrong-theme flash', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'light' });
  const page = await context.newPage();
  // Capture the attribute as early as possible: the inline head script must have run before any paint.
  await page.addInitScript(() => {
    (window as unknown as { __themeAtStart?: string | null }).__themeAtStart = null;
    document.addEventListener('DOMContentLoaded', () => {
      (window as unknown as { __themeAtStart?: string | null }).__themeAtStart = document.documentElement.getAttribute('data-theme');
    });
  });
  await page.goto('./#/settings');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  expect(await page.evaluate(() => (window as unknown as { __themeAtStart?: string | null }).__themeAtStart)).toBe('dark');
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to light mode');
  const box = await toggle.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode');
  await page.reload();
  expect(await page.evaluate(() => (window as unknown as { __themeAtStart?: string | null }).__themeAtStart)).toBe('light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 236, 218)');
  await context.close();
});

test('no horizontal scrolling and the primary control visible at 320, 375, 390 and 430 px', async ({ browser }) => {
  for (const width of [320, 375, 390, 430]) {
    const context = await browser.newContext({ viewport: { width, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    // First the welcome layer (a first visit), then the usual Listen screen: neither may overflow.
    await page.goto('./#/listen');
    await expect(page.getByTestId('welcome')).toBeVisible();
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(w.sw, `welcome at ${width}px`).toBeLessThanOrEqual(w.iw);
    for (const id of ['welcome-start', 'welcome-signin']) {
      const b = await page.getByTestId(id).boundingBox();
      expect(b!.x + b!.width, `${id} inside ${width}px`).toBeLessThanOrEqual(width);
      expect(b!.height, `${id} is a 44 px target`).toBeGreaterThanOrEqual(44);
    }
    // Then as a returning visitor (the later gotos only change the hash, so write the keys and reload).
    await page.evaluate(returningVisitor);
    await page.reload();
    for (const route of ['#/listen', '#/species', '#/settings']) {
      await page.goto(`./${route}`);
      await page.waitForTimeout(300);
      const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(scroll.sw, `${route} at ${width}px`).toBeLessThanOrEqual(scroll.iw);
    }
    await page.goto('./#/listen');
    const start = page.getByTestId('start-stop');
    await expect(start).toBeVisible();
    const b = await start.boundingBox();
    expect(b!.x + b!.width, `start button inside ${width}px`).toBeLessThanOrEqual(width);
    await context.close();
  }
});

/**
 * Height of the previous Settings → "Listen layout" card (h2 + dropdown + two-line helper text),
 * measured with getBoundingClientRect() at a 375 px viewport on main (commit efc0a2a) before the
 * preview-tile picker replaced it. The picker's card must stay within 1.5× of it (DECISIONS.md #44).
 */
const BASELINE_DROPDOWN_CARD_HEIGHT_PX = 210.59;

test('Listen layout picker: tiles select and persist, arrow keys move, height budget, no overflow at 320 px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('./#/settings');
  const group = page.getByTestId('listen-layout');
  await expect(group).toHaveAttribute('role', 'radiogroup');
  await expect(page.locator('select[aria-label="Listen layout"]')).toHaveCount(0);
  const tiles = group.getByRole('radio');
  await expect(tiles).toHaveCount(3);
  // Visible names (the first may carry a soft hyphen for 320 px) and clean accessible names.
  await expect(tiles).toHaveText([/^Consoli\u00AD?dated$/, 'Bottom dock', 'Focus']);
  for (const name of [/^Consolidated: /, /^Bottom dock: /, /^Focus: /]) await expect(group.getByRole('radio', { name })).toHaveAttribute('aria-checked', /true|false/);
  // Default selection and roving tabindex: the checked tile is the only one in the tab order.
  // First run opens in Focus (DECISIONS.md #63).
  await expect(page.getByTestId('listen-layout-focus')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('listen-layout-focus')).toHaveAttribute('tabindex', '0');
  await expect(page.getByTestId('listen-layout-consolidated')).toHaveAttribute('tabindex', '-1');
  await expect(page.getByTestId('listen-layout-dock')).toHaveAttribute('tabindex', '-1');
  // Height budget: the whole card is no taller than 1.5× the old dropdown card at 375 px.
  const card = group.locator('xpath=ancestor::section[contains(@class, "card")][1]');
  const cardBox = await card.boundingBox();
  expect(cardBox!.height).toBeLessThanOrEqual(1.5 * BASELINE_DROPDOWN_CARD_HEIGHT_PX);
  // Every tile is a 44 px target and fits inside the viewport in one row.
  const firstTile = await page.getByTestId('listen-layout-consolidated').boundingBox();
  for (const l of ['consolidated', 'dock', 'focus']) {
    const b = await page.getByTestId(`listen-layout-${l}`).boundingBox();
    expect(b!.width, `${l} width`).toBeGreaterThanOrEqual(44);
    expect(b!.height, `${l} height`).toBeGreaterThanOrEqual(44);
    expect(b!.x + b!.width, `${l} inside 375px`).toBeLessThanOrEqual(375);
    expect(b!.y, `${l} in one row`).toBeCloseTo(firstTile!.y, 0);
  }
  // Tap switches at once, is written to the store and survives a reload; the Listen view uses it.
  await page.getByTestId('listen-layout-dock').click();
  await expect(page.getByTestId('listen-layout-dock')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('listen-layout-consolidated')).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('birdbrain.settings.v1') ?? '{}').listenLayout)).toBe('dock');
  await page.reload();
  await expect(page.getByTestId('listen-layout-dock')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('listen-layout-dock')).toHaveAttribute('tabindex', '0');
  // Keyboard: arrows move focus and selection with wrap-around; Space/Enter select the focused tile.
  await page.getByTestId('listen-layout-dock').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('listen-layout-focus')).toBeFocused();
  await expect(page.getByTestId('listen-layout-focus')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('listen-layout-consolidated')).toBeFocused();
  await expect(page.getByTestId('listen-layout-consolidated')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('listen-layout-focus')).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('birdbrain.settings.v1') ?? '{}').listenLayout)).toBe('focus');
  await page.goto('./#/listen');
  await expect(page.locator('.listen')).toHaveAttribute('data-layout', 'focus');
  await context.close();

  // No horizontal overflow at 320 px with the Settings tab open: the Settings content and every tile
  // stay inside the viewport. (The document width is measured on the view, not on the root, because the
  // sticky header's status pill alone exceeds 320 px by a few px once it reads "Model ready · wasm",
  // a pre-existing header issue that this picker neither causes nor can fix.)
  const narrow = await browser.newContext({ viewport: { width: 320, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const np = await narrow.newPage();
  await np.goto('./#/settings');
  await expect(np.getByTestId('listen-layout')).toBeVisible();
  const widths = await np.evaluate(() => {
    const view = document.querySelector('main.view')!;
    return { view: view.scrollWidth, cards: Math.max(...[...document.querySelectorAll('main.view .card')].map((c) => c.getBoundingClientRect().right)) };
  });
  expect(widths.view, 'settings view scrollWidth at 320px').toBeLessThanOrEqual(320);
  expect(widths.cards, 'cards inside 320px').toBeLessThanOrEqual(320);
  for (const l of ['consolidated', 'dock', 'focus']) {
    const b = await np.getByTestId(`listen-layout-${l}`).boundingBox();
    expect(b!.x + b!.width, `${l} inside 320px`).toBeLessThanOrEqual(320);
    expect(b!.width, `${l} width at 320px`).toBeGreaterThanOrEqual(44);
  }
  await narrow.close();
});

for (const layout of ['consolidated', 'dock', 'focus'] as const) {
  test(`Listen layout ${layout}: ready, listening with the fake microphone, result cards, stop`, async ({ page }) => {
    await page.addInitScript((l) => {
      const raw = localStorage.getItem('birdbrain.settings.v1');
      const s = raw ? JSON.parse(raw) : {};
      s.listenLayout = l;
      localStorage.setItem('birdbrain.settings.v1', JSON.stringify(s));
    }, layout);
    await page.goto('./#/listen');
    await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
    await expect(page.locator('.listen')).toHaveAttribute('data-layout', layout);
    // One main action in the Ready state; nothing else is a filled button.
    const start = layout === 'dock' ? page.getByTestId('dock-start') : page.getByTestId('start-stop');
    await expect(start).toBeVisible();
    if (layout !== 'dock') {
      const box = await page.getByTestId('start-stop').boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(120);
    }
    // "How BirdNET decides" is the one row on Listen and starts closed, with its chip strip.
    // Focus shows no such row (DECISIONS.md #59).
    if (layout === 'focus') await expect(page.getByTestId('pipeline')).toHaveCount(0);
    else await expect(page.getByTestId('pipeline')).not.toHaveAttribute('open', /.*/);
    // Result cards from the sample clip: thumbnail tile, dot + name, scientific name, confidence.
    // Focus shows no sample button by design (DECISIONS.md #59), so click it through the DOM there.
    if (layout === 'focus') await page.getByTestId('demo').evaluate((b) => (b as HTMLButtonElement).click());
    else await page.getByTestId('demo').click();
    await expect(page.getByTestId('listen-status')).toContainText('Sample analysed', { timeout: 120_000 });
    const card = page.getByTestId('result-card').first();
    if (layout === 'focus') {
      await expect(page.getByTestId('results-empty')).toBeHidden();
    } else {
      await expect(page.getByTestId('results')).toContainText('Lesser Redpoll');
      await expect(card).toContainText(/Redpoll/);
      await expect(card).toContainText(/Acanthis/);
      await expect(card).toContainText(/\d+%/);
      await expect(card.locator('.result-thumb').first()).toBeAttached();
    }
    // Listening with the fake microphone: panel/dock/focus card, status text, conditions line, timer.
    await start.click();
    await expect(page.getByTestId('model-status')).toContainText('Listening', { timeout: 30_000 });
    if (layout === 'dock') {
      await expect(page.getByTestId('dock')).toContainText('Listening');
      await expect(page.getByTestId('dock-stop')).toBeVisible();
    } else {
      await expect(page.getByTestId('listen-panel')).toBeVisible();
      await expect(page.getByTestId('conditions')).toContainText('Conditions:', { timeout: 15_000 });
      await expect(page.getByTestId('stop')).toBeVisible();
    }
    if (layout === 'focus') {
      await expect(page.getByTestId('focus-latest')).toBeVisible();
      await expect(page.getByTestId('more-birds')).toBeVisible();
    }
    await page.waitForTimeout(1500);
    if (layout === 'consolidated') {
      // Live pipeline chips (DECISIONS.md #57): the stages light in order while the mic is on.
      await page.getByTestId('pipeline').getByText('How BirdNET decides').click();
      await expect(page.getByTestId('pipeline-live')).toBeVisible();
      const chips = page.getByTestId('pipeline-chips');
      await expect(chips.locator('.pchip.active, .pchip.done')).not.toHaveCount(0, { timeout: 15_000 });
      // Mic runs before Result, so it is lit (active or done) before Result ever is.
      await expect(chips.locator('.pchip[data-stage="mic"]')).toHaveClass(/active|done/, { timeout: 15_000 });
    }
    const stop = layout === 'dock' ? page.getByTestId('dock-stop') : page.getByTestId('stop');
    await stop.click();
    await expect(page.getByTestId('model-status')).toContainText('Model ready');
    await expect(page.getByTestId('listen-status')).toContainText('Stopped.');
    if (layout === 'consolidated') {
      // Stopped: every chip plain again.
      const chips = page.getByTestId('pipeline-chips');
      await expect(chips.locator('.pchip.active, .pchip.done')).toHaveCount(0);
      await expect(page.getByTestId('pipeline-live')).toBeHidden();
      // Reduce motion: no stepping, only a finished window lights Result.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await start.click();
      await expect(page.getByTestId('model-status')).toContainText('Listening', { timeout: 30_000 });
      await page.waitForTimeout(4000);
      for (const stage of ['mic', 'resample', 'window', 'spectrogram', 'network', 'filter']) {
        await expect(chips.locator(`.pchip[data-stage="${stage}"]`), `${stage} stays plain with reduce motion`).not.toHaveClass(/active|done/);
      }
      await page.getByTestId('stop').click();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
  });
}

test('Settings rows: the admin delete row is disabled, and the folds fit 320 px closed and open', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  // A cached admin session: the delete row must be greyed out, with the reason on the row.
  await page.addInitScript(() => {
    localStorage.setItem('birdbrain.auth.v1', JSON.stringify({ token: 'e2e-admin', expiresAt: null, user: { id: 'a1', email: 'admin@example.com', name: 'Sabih', status: 'approved', role: 'admin' } }));
    // The Listen folds checked below belong to the Consolidated layout (Focus is the first-run default).
    if (!localStorage.getItem('birdbrain.settings.v1')) localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ listenLayout: 'consolidated' }));
  });
  await page.route(/\/v1\//, (route) => route.abort());
  await page.goto('./#/settings');
  await expect(page.getByTestId('account-role')).toHaveText('Admin');
  await expect(page.getByTestId('account-name')).toHaveText('Sabih');
  const del = page.getByTestId('delete-row');
  await expect(del).toBeDisabled();
  await expect(del).toContainText('Not available for the admin account');
  // Dispatch straight at the row: a coordinate click at 320 px would land on the fixed tab bar.
  await del.dispatchEvent('click');
  await expect(page.getByTestId('delete-screen')).toHaveCount(0);
  // No horizontal scrolling with every section open either.
  const noScroll = async (label: string) => {
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(m.sw, label).toBeLessThanOrEqual(m.iw);
  };
  await noScroll('settings closed at 320px');
  const fold = page.getByTestId('what-we-store');
  await fold.scrollIntoViewIfNeeded();
  const foldBox = await fold.locator('summary').boundingBox();
  const barTop = await page.evaluate(() => {
    const bar = document.querySelector('nav.tabs, .tabs');
    return bar ? bar.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
  });
  expect(foldBox!.y + foldBox!.height, 'the last row on Settings clears the tab bar').toBeLessThanOrEqual(barTop + 1);
  await fold.getByText('What we store').click();
  await expect(page.getByText('Only on this phone')).toBeVisible();
  await noScroll('what we store open at 320px');
  await page.goto('./#/listen');
  await page.getByTestId('pipeline').getByText('How BirdNET decides').click();
  await expect(page.getByTestId('pipeline-list')).toBeVisible();
  await expect(page.getByTestId('pipeline-list')).toContainText('An EfficientNet-style network scores all 6,522 classes');
  // The limits note sits after the list, inside the same section.
  await expect(page.getByTestId('pipeline')).toContainText('It does not separate overlapping calls or count individuals.');
  await expect(page.getByTestId('pipeline').getByRole('link', { name: 'More about limits' })).toBeVisible();
  await noScroll('pipeline open at 320px');
  // The summary is a real tap target and keeps the focus ring.
  const box = await page.getByTestId('pipeline').locator('summary').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await context.close();
});

test('Listen layouts: the picker switches at once, each Ready state differs, and the mic keeps running', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
  const page = await context.newPage();
  await page.addInitScript(returningVisitor); // the usual Listen screen, not the first-visit welcome
  // Count getUserMedia calls, so switching layout while listening can be shown not to restart the mic.
  await page.addInitScript(() => {
    const w = window as unknown as { __mic: number };
    w.__mic = 0;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c?: MediaStreamConstraints) => {
      w.__mic += 1;
      return real(c ?? {});
    };
  });
  const micCalls = () => page.evaluate(() => (window as unknown as { __mic: number }).__mic);

  const pick = async (layout: 'consolidated' | 'dock' | 'focus') => {
    await page.goto('./#/settings');
    await page.getByTestId(`listen-layout-${layout}`).click();
    await page.goto('./#/listen');
  };
  const listen = page.locator('.listen');

  // 1. Ready, without pressing Start: each layout has its own signature.
  await pick('consolidated');
  await expect(listen).toHaveAttribute('data-layout', 'consolidated');
  await expect(page.getByTestId('start-stop')).toBeVisible();
  await expect(page.getByTestId('dock')).toBeHidden();

  await pick('dock');
  await expect(listen).toHaveAttribute('data-layout', 'dock');
  await expect(page.getByTestId('dock')).toBeVisible();
  await expect(page.getByTestId('start-stop')).toBeHidden(); // no round mic button anywhere
  await expect(page.getByTestId('recent-inline')).toBeVisible(); // cards fill the screen
  await expect(page.getByTestId('dock-start')).toBeVisible();

  await pick('focus');
  await expect(listen).toHaveAttribute('data-layout', 'focus');
  await expect(page.getByTestId('start-stop')).toHaveClass(/big/);
  await expect(page.getByTestId('dock')).toBeHidden();
  await expect(page.getByTestId('recent-fold')).toHaveCount(0); // no lists on the Focus screen
  await expect(page.getByTestId('pipeline')).toHaveCount(0);
  await expect(page.getByTestId('context-chips')).toBeHidden();

  // 2. The choice survives a reload and is right on the first paint, with no flash.
  await page.reload();
  await expect(listen).toHaveAttribute('data-layout', 'focus');
  const early = await page.evaluate(() => document.querySelector('.listen')?.getAttribute('data-layout'));
  expect(early).toBe('focus');

  // 3. Switching while listening only rearranges: no mic restart, detection keeps running.
  await pick('consolidated');
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 240_000 });
  await page.getByTestId('start-stop').click();
  await expect(page.getByTestId('model-status')).toContainText('Listening', { timeout: 30_000 });
  const callsWhileListening = await micCalls();
  expect(callsWhileListening).toBeGreaterThan(0);
  await expect(page.getByTestId('listen-panel')).toBeVisible(); // Consolidated: panel at the top

  for (const layout of ['dock', 'focus', 'consolidated'] as const) {
    await page.goto('./#/settings');
    await page.getByTestId(`listen-layout-${layout}`).click();
    await page.goto('./#/listen');
    await expect(listen).toHaveAttribute('data-layout', layout);
    await expect(page.getByTestId('model-status')).toContainText('Listening');
    if (layout === 'dock') await expect(page.getByTestId('dock')).toContainText('Listening');
    if (layout === 'focus') {
      await expect(page.getByTestId('focus-latest')).toBeVisible();
      await expect(page.getByTestId('more-birds')).toBeVisible();
    }
    if (layout === 'consolidated') await expect(page.getByTestId('listen-panel')).toBeVisible();
  }
  // Still the same microphone: no second getUserMedia for any of those switches.
  expect(await micCalls()).toBe(callsWhileListening);
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('model-status')).toContainText('Model ready');
  await context.close();
});

test('mic blocked state explains the iPhone steps and offers Try again and import', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], permissions: [] });
  const page = await context.newPage();
  // The fake-media flags auto-grant the microphone; make getUserMedia refuse like a denied permission instead.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  });
  await page.addInitScript(returningVisitor);
  await page.goto('./#/listen');
  await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
  await page.getByTestId('start-stop').click();
  await expect(page.locator('.listen')).toHaveAttribute('data-status', 'mic-blocked', { timeout: 30_000 });
  await expect(page.getByTestId('try-again')).toBeVisible();
  await expect(page.getByTestId('model-status')).toContainText('Mic blocked');
  await expect(page.getByTestId('mic-steps')).toContainText('Settings → Safari → Microphone');
  await expect(page.getByTestId('mic-steps')).toContainText('import a recording');
  await context.close();
});


for (const layout of ['consolidated', 'dock', 'focus'] as const) {
  test(`Recent sightings (${layout}): one card per species, best + Heard once + last, expands to the lumped detections and collapses`, async ({ page }) => {
    await page.addInitScript((l) => {
      const raw = localStorage.getItem('birdbrain.settings.v1');
      const s = raw ? JSON.parse(raw) : {};
      s.listenLayout = l;
      localStorage.setItem('birdbrain.settings.v1', JSON.stringify(s));
    }, layout);
    await page.goto('./#/listen');
    await expect(page.getByTestId('model-status')).toContainText('Model ready', { timeout: 200_000 });
    // Consolidated keeps the cards behind the collapsed row, Bottom dock shows them on the page,
    // and Focus has no list at all (DECISIONS.md #59).
    if (layout === 'focus') await expect(page.getByTestId('recent-fold')).toHaveCount(0);
    else await expect(page.getByTestId('recent-empty')).toBeAttached();
    if (layout === 'focus') await page.getByTestId('demo').evaluate((b) => (b as HTMLButtonElement).click());
    else await page.getByTestId('demo').click();
    await expect(page.getByTestId('listen-status')).toContainText('Sample analysed', { timeout: 120_000 });
    // The live results list shows the best confidence labelled "best" and the count.
    if (layout !== 'focus') {
      const result = page.getByTestId('result-card').first();
      await expect(result).toContainText(/best\s*\d+%/);
      await expect(result).toContainText('Heard once');
    } else {
      await expect(page.getByTestId('focus-latest')).toContainText('Heard once');
    }
    // Recent sightings: one card per species, a real button with aria-expanded, at least 44 px tall.
    if (layout === 'focus') {
      // Nothing more to check here: Focus shows the hero card and "N more birds" instead.
      await expect(page.getByTestId('more-birds')).toBeAttached();
      return;
    }
    const summaryId = layout === 'dock' ? 'recent-inline-summary' : 'recent-summary';
    await expect(page.getByTestId(summaryId)).toHaveText(/^\d+ birds? · \d+ detections?$/);
    if (layout === 'dock') {
      // The cards are already on the page in this layout.
      await expect(page.getByTestId('recent-inline')).toBeVisible();
    } else {
      await page.getByTestId('recent-fold').locator('summary').click();
    }
    await expect(page.getByTestId('recent-empty')).toBeHidden();
    const cards = page.getByTestId('recent-card');
    const n = await cards.count();
    expect(n).toBeGreaterThanOrEqual(1);
    const keys = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-species')));
    expect(new Set(keys).size, 'no duplicate species cards').toBe(keys.length);
    const card = cards.first();
    await expect(card).toHaveAttribute('aria-expanded', 'false');
    await expect(card).toHaveAttribute('aria-label', /^.+, heard once, best \d+%, last at .+$/);
    await expect(card).toContainText(/Acanthis/);
    await expect(card).toContainText(/best\s*\d+%/);
    await expect(card.getByTestId('recent-count')).toHaveText('Heard once');
    await expect(card).toContainText(/last\s*\d/);
    const box = await card.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(page.getByTestId('recent-rows').first()).toBeHidden();
    // Tap expands: the lumped detections, newest first, each with time (or range), hit count and best.
    await card.click();
    const expandedCard = page.getByTestId('recent-card').first();
    await expect(expandedCard).toHaveAttribute('aria-expanded', 'true');
    const rows = page.getByTestId('recent-rows').first();
    await expect(rows).toBeVisible();
    await expect(rows.locator('.recent-row').first()).toContainText(/\d{1,2}:\d{2}:\d{2}/);
    await expect(rows.locator('.recent-row').first()).toContainText(/\d+ hits? · best \d+%/);
    // Tap again collapses.
    await expandedCard.click();
    await expect(page.getByTestId('recent-card').first()).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('recent-rows').first()).toBeHidden();
    // Nothing on the screen overflows the phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('User management: admin-only button in Settings, confirmations, plain results, fits 320 px in both themes', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('birdbrain.auth.v1', JSON.stringify({ token: 'e2e-admin', expiresAt: null, user: { id: 'a1', email: 'admin@example.com', name: 'Sabih', status: 'approved', role: 'admin' } }));
  });
  const users = [
    { id: 'a1', email: 'admin@example.com', name: 'Sabih', status: 'approved', role: 'admin', emailVerified: true, createdAt: '2026-10-01T10:00:00Z' },
    { id: 'u2', email: 'a.really.long.address.for.a.new.member@example-birding-club.org', name: 'Robin', status: 'pending', role: 'member', emailVerified: true, createdAt: '2026-10-20T10:00:00Z' },
  ];
  const posted: string[] = [];
  await page.route(/\/v1\//, (route) => route.abort());
  await page.route(/\/v1\/admin\/users$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users }) }));
  await page.route(/\/v1\/admin\/users\/u2\/(reset-password|delete)$/, (route) => {
    posted.push(`${new URL(route.request().url()).pathname} ${route.request().postData()}`);
    const reset = route.request().url().endsWith('reset-password');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, emailed: !reset }) });
  });
  await page.goto('./#/settings');
  const manage = page.getByTestId('manage-users');
  await expect(manage).toContainText('Manage users');
  await manage.dispatchEvent('click');
  await expect(page).toHaveURL(/#\/admin\/users$/);
  await expect(page.getByRole('heading', { name: 'User management' })).toBeVisible();
  const rows = page.getByTestId('admin-user');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('(you)');
  await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
  const robin = rows.nth(1);
  await expect(robin).toContainText('Robin');
  await expect(robin.getByTestId('admin-user-status')).toContainText('Waiting for approval');
  for (const name of ['Approve', 'Reject', 'Reset password', 'Delete']) {
    const box = await robin.getByRole('button', { name, exact: true }).boundingBox();
    expect(box!.height, `${name} is a 44 px target`).toBeGreaterThanOrEqual(44);
  }
  const noScroll = async (label: string) => {
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    expect(m.sw, label).toBeLessThanOrEqual(m.iw);
  };
  await noScroll('user list at 320px, dark');

  // Reset asks first; a failed mail is said plainly.
  await robin.getByTestId('user-reset').dispatchEvent('click');
  await expect(robin.getByTestId('confirm-panel')).toContainText('temporary password');
  await robin.getByTestId('confirm-reset').dispatchEvent('click');
  await expect(page.getByTestId('admin-result')).toHaveText('Password reset, but the email could not be sent. Try again.');

  // Delete stays disabled until the address is typed.
  await rows.nth(1).getByTestId('user-delete').dispatchEvent('click');
  const go = rows.nth(1).getByTestId('confirm-delete');
  await expect(go).toBeDisabled();
  await rows.nth(1).getByTestId('delete-email').fill('someone@else.org');
  await expect(go).toBeDisabled();
  await rows.nth(1).getByTestId('delete-email').fill(users[1].email);
  await expect(go).toBeEnabled();
  await noScroll('delete confirmation at 320px, dark');
  await page.getByTestId('theme-toggle').click();
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
  await noScroll('delete confirmation at 320px, light');
  await go.dispatchEvent('click');
  await expect(page.getByTestId('admin-result')).toContainText('was deleted');
  expect(posted).toEqual(['/v1/admin/users/u2/reset-password {}', `/v1/admin/users/u2/delete ${JSON.stringify({ confirm: users[1].email })}`]);
  await expect(page.getByTestId('admin-costs-link')).toHaveAttribute('href', '#/admin');
  await context.close();

  // A member sees no button, and the page itself refuses.
  const member = await browser.newContext({ viewport: { width: 375, height: 740 } });
  const mp = await member.newPage();
  await mp.addInitScript(() => {
    localStorage.setItem('birdbrain.auth.v1', JSON.stringify({ token: 'e2e-member', expiresAt: null, user: { id: 'm1', email: 'm@example.com', name: 'Mo', status: 'approved', role: 'member' } }));
  });
  await mp.route(/\/v1\//, (route) => route.abort());
  await mp.goto('./#/settings');
  await expect(mp.getByTestId('account-role')).toHaveText('Member');
  await expect(mp.getByTestId('manage-users')).toHaveCount(0);
  await mp.goto('./#/admin/users');
  await expect(mp.getByTestId('admin-only')).toContainText('Only the admin can open this page.');
  await member.close();
});

test('Listen credits BirdNET, inside the viewport and clear of the dock and tab bar, in all three layouts at 320 px, with no eBird text', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  for (const layout of ['consolidated', 'dock', 'focus'] as const) {
    await page.addInitScript((l) => {
      const raw = localStorage.getItem('birdbrain.settings.v1');
      const s = raw ? JSON.parse(raw) : {};
      s.listenLayout = l;
      localStorage.setItem('birdbrain.settings.v1', JSON.stringify(s));
    }, layout);
    await page.goto('./#/listen');
    await page.reload();
    await expect(page.locator('.listen')).toHaveAttribute('data-layout', layout);
    const credit = page.getByTestId('birdnet-credit');
    await expect(credit, layout).toHaveText('Bird ID: BirdNET, Cornell Lab of Ornithology and Chemnitz University of Technology · CC BY-NC-SA 4.0');
    await expect(credit.getByRole('link', { name: 'BirdNET' })).toHaveAttribute('href', 'https://birdnet.cornell.edu');
    await expect(credit.getByRole('link', { name: 'CC BY-NC-SA 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-nc-sa/4.0/');
    await expect(credit).toHaveClass(/source-credit/);
    // Small and muted, never larger than body text.
    const size = await credit.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(size, `${layout} credit size`).toBeLessThanOrEqual(12);
    // Inside the viewport, above the dock (when there is one) and the tab bar, no horizontal overflow.
    await credit.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await expect(credit).toBeVisible();
    const box = (await credit.boundingBox())!;
    const bars = await page.evaluate(() => {
      const top = (sel: string) => {
        const n = document.querySelector<HTMLElement>(sel);
        return n && n.offsetParent !== null && getComputedStyle(n).display !== 'none' ? n.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
      };
      return { tabs: top('.tabs'), dock: top('[data-testid="dock"]'), innerHeight: window.innerHeight, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(box.x, `${layout} left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${layout} right edge`).toBeLessThanOrEqual(320);
    expect(box.y, `${layout} top edge`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${layout} above the tab bar`).toBeLessThanOrEqual(Math.min(bars.tabs, bars.innerHeight) + 1);
    if (layout === 'dock') expect(box.y + box.height, 'above the dock').toBeLessThanOrEqual(bars.dock + 1);
    expect(bars.scrollWidth, `${layout} no horizontal scroll`).toBeLessThanOrEqual(320);
    // Listen shows no eBird data, so it carries no eBird credit or mention.
    expect(await page.locator('.listen').innerText()).not.toMatch(/ebird/i);
  }
  await context.close();
});

test('an answer credits eBird and NatureServe only when its sources include them', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('birdbrain.auth.v1', JSON.stringify({ token: 'e2e', expiresAt: null, user: { id: 'u1', email: 'member@example.com', name: 'member', status: 'approved', role: 'member' } }));
  });
  await page.route(/\/v1\//, (route) => route.abort());
  const wiki = { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Lesser_redpoll' };
  const ebird = { name: 'eBird', url: 'https://ebird.org/region/US-IA' };
  const ns = { name: 'NatureServe Explorer', url: 'https://explorer.natureserve.org/Taxon/ELEMENT_GLOBAL.2.1' };
  const answers = [
    { answer: 'Reported twice in Iowa this month [eBird – Recent sightings].', sources: [wiki, ebird, ns] },
    { answer: 'Globally secure [NatureServe Explorer – Status].', sources: [wiki, ns] },
    { answer: 'It eats seeds [Wikipedia – Diet].', sources: [wiki] },
  ];
  let n = 0;
  await page.route(/\/v1\/ask$/, (route) => {
    const a = answers[Math.min(n++, answers.length - 1)];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...a, source: { title: 'Lesser redpoll', url: wiki.url }, citations: [], context: 'article', region: 'US-IA' }) });
  });
  await page.goto('./#/species/Acanthis%20cabaret');
  const box = page.getByTestId('ask-box');
  const question = box.getByLabel('Your question');
  await expect(question).toBeVisible({ timeout: 60_000 });
  const askOnce = async (q: string) => {
    await question.fill(q);
    await box.getByRole('button', { name: 'Ask' }).click();
    await expect(box.getByTestId('ask-sources')).toBeVisible();
  };

  // 1. eBird and NatureServe used: both credited, in that order, with the right links.
  await askOnce('Seen in my state recently?');
  const credits = box.getByTestId('answer-credits');
  await expect(credits).toHaveText('Local sightings in answers: eBird.org · Conservation status: NatureServe Explorer');
  await expect(credits.getByRole('link', { name: 'eBird.org' })).toHaveAttribute('href', 'https://ebird.org');
  await expect(credits.getByRole('link', { name: 'NatureServe Explorer' })).toHaveAttribute('href', 'https://explorer.natureserve.org');
  await expect(credits).toHaveClass(/answer-credit/);
  // 75% of the answer paragraph's text size, muted.
  const sizes = await box.getByTestId('ask-answer').evaluate((e) => ({ answer: parseFloat(getComputedStyle(e.querySelector('p')!).fontSize), credit: parseFloat(getComputedStyle(e.querySelector('.answer-credit')!).fontSize) }));
  expect(sizes.credit).toBeCloseTo(sizes.answer * 0.75, 1);

  // 2. NatureServe only: no eBird text anywhere in the answer.
  await askOnce('Is it threatened?');
  await expect(credits).toHaveText('Conservation status: NatureServe Explorer');
  expect(await box.getByTestId('ask-answer').innerText()).not.toMatch(/ebird/i);

  // 3. Wikipedia only: no credit element at all.
  await askOnce('What does it eat?');
  await expect(box.getByTestId('ask-sources')).toContainText('Wikipedia');
  await expect(box.getByTestId('answer-credits')).toHaveCount(0);
});

test('a browser without WebAssembly is told which browsers work, and no model byte is requested', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ listenLayout: 'consolidated' }));
    Object.defineProperty(window, 'WebAssembly', { value: undefined, configurable: true, writable: true });
  });
  // Every request for a model file (labels.json is the offline species list and stays allowed).
  const modelRequests: string[] = [];
  await page.route(/\/models\/birdnet-v2\.4\//, (route) => {
    if (!/labels\.json$/.test(route.request().url())) modelRequests.push(route.request().url());
    void route.continue();
  });
  await page.goto('./#/listen');
  const listen = page.locator('.listen');
  await expect(listen).toHaveAttribute('data-status', 'unsupported', { timeout: 60_000 });
  const block = page.getByTestId('ready-block');
  await expect(block).toContainText("This browser can't run the bird model.");
  await expect(block).toContainText('It works in current Safari, Chrome, Firefox and Edge.');
  await expect(page.getByTestId('model-status')).toContainText('Browser not supported');
  await expect(page.getByTestId('try-again')).toBeHidden();
  await expect(page.getByTestId('start-stop')).toBeHidden();
  await expect(page.getByTestId('demo')).toBeHidden();
  // Give a stray download a moment to show up, then check that none did.
  await page.waitForTimeout(2000);
  expect(modelRequests).toEqual([]);
  // The rest of the app still works, and the text fits at 320 px in both themes.
  await page.getByRole('link', { name: 'Species' }).click();
  await page.getByRole('searchbox', { name: 'Search species' }).fill('redpoll');
  await expect(page.getByTestId('species-list')).toContainText('Lesser Redpoll');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('./#/listen');
  await expect(listen).toHaveAttribute('data-status', 'unsupported');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await block.boundingBox();
    expect(box, theme).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    await expect(block).toContainText('It works in current Safari, Chrome, Firefox and Edge.');
  }
  await context.close();
});

test('maps stay under the sticky header and the tab bar while scrolling (DECISIONS.md #74)', async ({ browser }) => {
  // A short screen so the map reaches under the tab bar at first, and under the header after a scroll.
  const context = await browser.newContext({ viewport: { width: 390, height: 360 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ listenLayout: 'consolidated' }));
    localStorage.setItem('birdbrain.model.v1', 'wanted');
  });
  await page.goto('./#/map');
  const map = page.getByTestId('map');
  await expect(map.locator('.leaflet-pane').first()).toBeAttached();
  const topmost = (x: number, y: number) =>
    page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return el?.closest('.app-header') ? 'header' : el?.closest('.tabs') ? 'tabs' : el?.closest('.leaflet-container, .map') ? 'map' : (el?.tagName ?? 'none');
    }, [x, y] as const);
  const tabBox = (await page.locator('.tabs').boundingBox())!;
  const mapBox = (await map.boundingBox())!;
  expect(mapBox.y + mapBox.height, 'the map reaches under the tab bar on this short screen').toBeGreaterThan(tabBox.y);
  expect(await topmost(195, tabBox.y + tabBox.height / 2)).toBe('tabs');
  // Scroll so the map passes under the sticky header.
  const headerBox = (await page.locator('.app-header').boundingBox())!;
  await page.evaluate((dy) => window.scrollBy(0, dy), mapBox.y - headerBox.y);
  await page.waitForTimeout(200);
  const mapAfter = (await map.boundingBox())!;
  expect(mapAfter.y, 'the map now starts under the header').toBeLessThan(headerBox.y + headerBox.height);
  expect(await topmost(195, headerBox.y + headerBox.height / 2)).toBe('header');
  await context.close();
});
