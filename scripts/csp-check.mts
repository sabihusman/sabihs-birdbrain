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
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  let file = path.join(root, p);
  if (file.startsWith(root) && !fs.existsSync(file) && p.startsWith('/models/')) file = path.join(repo, p);
  if (!(file.startsWith(root) || file.startsWith(path.join(repo, 'models'))) || !fs.existsSync(file)) {
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
