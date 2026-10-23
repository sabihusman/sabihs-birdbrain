/**
 * Serve dist/ with the headers from vercel.json and record CSP violations while using the app.
 * A CI-style build (VITE_MODEL_BASE_URL=/models/birdnet-v2.4/) holds no weights (DECISIONS.md #56),
 * so files missing from dist/ are served from the repository's models/ folder, as preview does.
 */
import { chromium, devices } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '../dist');
const repo = path.resolve(import.meta.dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../vercel.json'), 'utf8')) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
const global = vercel.headers.find((h) => h.source === '/(.*)')!.headers;
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav' };
const modelsDir = path.join(repo, 'models');

/** Map a request path to a file under dist/ (or models/ for weights); null for anything outside those folders or missing. */
function resolveFile(urlPath: string): string | null {
  // Only a plain relative path with safe characters is accepted: no "..", no backslashes, no control characters.
  const rel = path.posix.normalize(urlPath).replace(/^\/+/, '');
  if (rel.split('/').some((seg) => seg === '..' || seg === '') && rel !== '') return null;
  if (!/^[A-Za-z0-9._/-]*$/.test(rel)) return null;
  const inDist = path.resolve(root, rel);
  if (inDist === root || inDist.startsWith(root + path.sep)) {
    if (fs.existsSync(inDist) && fs.statSync(inDist).isFile()) return inDist;
  }
  if (rel.startsWith('models/')) {
    const inModels = path.resolve(modelsDir, rel.slice('models/'.length));
    if (inModels.startsWith(modelsDir + path.sep) && fs.existsSync(inModels) && fs.statSync(inModels).isFile()) return inModels;
  }
  return null;
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = resolveFile(p);
  if (!file) {
    res.writeHead(404);
    res.end();
    return;
  }
  for (const h of global) res.setHeader(h.key, h.value);
  res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(4180, r));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
const violations: string[] = [];
await page.addInitScript(() => {
  // The demo button is hidden in the Focus layout, the first-run default (DECISIONS.md #63).
  if (!localStorage.getItem('birdbrain.settings.v1')) localStorage.setItem('birdbrain.settings.v1', JSON.stringify({ listenLayout: 'consolidated' }));
  // A returning visitor who asked for the model before: it loads at start (DECISIONS.md #69).
  localStorage.setItem('birdbrain.model.v1', 'wanted');
  document.addEventListener('securitypolicyviolation', (e) => {
    (window as unknown as { __csp: string[] }).__csp ??= [];
    (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile}:${e.lineNumber}`);
  });
});
page.on('console', (m) => {
  if (/Content Security Policy|Refused to/.test(m.text())) violations.push(`[console] ${m.text().slice(0, 200)}`);
});
const collect = async () => {
  const v = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  violations.push(...v);
  await page.evaluate(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
  });
};
await page.goto('http://localhost:4180/');
await page.getByTestId('model-status').filter({ hasText: 'Model ready' }).waitFor({ timeout: 240_000 });
await page.getByTestId('demo').click();
await page.getByTestId('results').filter({ hasText: 'Redpoll' }).waitFor({ timeout: 120_000 });
await collect();
await page.goto('http://localhost:4180/#/map');
await page.waitForTimeout(3000);
await collect();
// Places view (DECISIONS.md #72): one located sighting and a stubbed Overpass answer. The CSP is
// checked before a request reaches page.route, so a blocked connect-src would still be reported.
await page.route('https://overpass-api.de/api/interpreter', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ elements: [{ type: 'count', id: 0 }, { type: 'way', id: 1 }, { type: 'count', id: 0 }, { type: 'way', id: 1, bounds: { minlat: 41.69, minlon: -93.71, maxlat: 41.71, maxlon: -93.69 }, tags: { leisure: 'park', name: 'CSP Check Park' } }] }),
  }),
);
await page.evaluate(
  () =>
    new Promise<void>((resolve) => {
      const req = indexedDB.open('sabihs-birdbrain');
      req.onsuccess = () => {
        const tx = req.result.transaction('sightings', 'readwrite');
        const t = Date.now();
        tx.objectStore('sightings').put({ id: 'csp-1', label: 'Poecile atricapillus_Black-capped Chickadee', scientific: 'Poecile atricapillus', common: 'Black-capped Chickadee', firstTime: t, lastTime: t, peakConfidence: 0.8, hits: 1, lat: 41.7, lon: -93.7, accuracy: 10, recordingId: null, offsetSec: null, source: 'live', sessionId: 'csp', peakDetectionId: 'csp-d1' });
        tx.oncomplete = () => resolve();
      };
    }),
);
await page.goto('http://localhost:4180/#/settings');
await page.goto('http://localhost:4180/#/map');
await page.getByRole('tab', { name: 'Places' }).click();
await page.getByTestId('map-place-card').filter({ hasText: 'CSP Check Park' }).waitFor({ timeout: 20_000 });
await collect();
await page.goto('http://localhost:4180/#/species/Acanthis%20cabaret');
await page.waitForTimeout(3000);
await collect();
await page.goto('http://localhost:4180/#/settings');
await page.waitForTimeout(1000);
await collect();
await page.goto('http://localhost:4180/#/recordings');
await page.locator('#import-file').setInputFiles(path.resolve(import.meta.dirname, '../public/samples/birdnet-sample.wav'));
await page.getByText(/Analysed \d+ windows/).waitFor({ timeout: 120_000 });
await collect();
console.log('model status:', await page.getByTestId('model-status').textContent());
console.log('CSP violations:', violations.length ? violations : 'none');
await browser.close();
server.close();
process.exit(violations.length ? 1 : 0);
