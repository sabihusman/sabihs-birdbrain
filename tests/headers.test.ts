import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('Vercel builds only the production branch (vercel.json git.deploymentEnabled)', () => {
  const vercel = JSON.parse(read('vercel.json')) as { git?: { deploymentEnabled?: Record<string, boolean> | boolean } };

  /**
   * The free plan allows a limited number of builds per day, and a preview build per push
   * exhausted it on 2026-10-20, which left a merged change undeployed. Unspecified branches
   * default to true, so the catch-alls are what switch previews off; "main" wins because a
   * branch that matches several rules deploys when any of them is true.
   */
  it('deploys main and nothing else', () => {
    const rules = vercel.git?.deploymentEnabled;
    expect(typeof rules).toBe('object');
    const r = rules as Record<string, boolean>;
    expect(r.main).toBe(true);
    // "*" does not cross a slash in minimatch, so branches like claude/x need "**" too.
    expect(r['*']).toBe(false);
    expect(r['**']).toBe(false);
  });
});

describe('front-end response headers (vercel.json)', () => {
  const vercel = JSON.parse(read('vercel.json')) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
  const site = vercel.headers.find((h) => h.source === '/(.*)')!;
  const header = (key: string) => site.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

  it('sends a Referer to tile and image hosts: Referrer-Policy is not no-referrer', () => {
    // OpenStreetMap's tile usage policy requires a Referer; no-referrer made every tile a 403 (DECISIONS.md #30).
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('Referrer-Policy')).not.toMatch(/no-referrer/);
  });

  it('nothing else forces no-referrer: no meta tag, no Leaflet referrerPolicy option', () => {
    expect(read('index.html')).not.toMatch(/<meta[^>]+name=["']referrer["']/i);
    expect(read('src/ui/views/map.ts')).not.toMatch(/referrerPolicy/);
    expect(read('src/ui/views/map.ts')).not.toMatch(/no-referrer/);
  });

  it('allow-lists exactly the inline theme script in index.html (no unsafe-inline)', () => {
    const html = read('index.html');
    const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    const sha = createHash('sha256').update(scripts[0]).digest('base64');
    const csp = header('Content-Security-Policy')!;
    expect(csp).toContain(`'sha256-${sha}'`);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(scripts[0]).toMatch(/data-theme/);
  });

  it('keeps the CSP allowing OSM tiles', () => {
    expect(header('Content-Security-Policy')).toMatch(/img-src[^;]*https:\/\/tile\.openstreetmap\.org/);
  });

  it('lets the Places view reach Nominatim and nothing else new (DECISIONS.md #73)', () => {
    const connect = /connect-src ([^;]*)/.exec(header('Content-Security-Policy')!)![1].split(/\s+/);
    expect(connect).toEqual(["'self'", 'https://bird-brain.duckdns.org', 'https://en.wikipedia.org', 'https://nominatim.openstreetmap.org']);
  });
});
