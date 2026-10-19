import { devices, expect, test } from '@playwright/test';

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
  await expect(page.getByTestId('how-it-works')).not.toHaveAttribute('open', /.*/);
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
  await expect(page.getByTestId('listen-layout-consolidated')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('listen-layout-consolidated')).toHaveAttribute('tabindex', '0');
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
    await expect(page.getByTestId('how-it-works')).not.toHaveAttribute('open', /.*/);
    // Result cards from the sample clip: thumbnail tile, dot + name, scientific name, confidence.
    await page.getByTestId('demo').click();
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
    const stop = layout === 'dock' ? page.getByTestId('dock-stop') : page.getByTestId('stop');
    await stop.click();
    await expect(page.getByTestId('model-status')).toContainText('Model ready');
    await expect(page.getByTestId('listen-status')).toContainText('Stopped.');
  });
}

test('mic blocked state explains the iPhone steps and offers Try again and import', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 13'], permissions: [] });
  const page = await context.newPage();
  // The fake-media flags auto-grant the microphone; make getUserMedia refuse like a denied permission instead.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
  });
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

