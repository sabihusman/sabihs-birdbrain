import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Width and height from the IHDR chunk, which always follows the 8-byte PNG signature. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const SITE = 'https://sabihs-birdbrain.vercel.app/';

/** Link previews and the static shell text (DECISIONS.md #67). */
describe('index.html link previews', () => {
  const html = read('index.html');
  const meta = (attr: 'property' | 'name', key: string) => {
    const m = html.match(new RegExp(`<meta ${attr}="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`));
    return m?.[1];
  };

  it('has the Open Graph tags', () => {
    expect(meta('property', 'og:title')).toBe('Sabih’s Birdbrain');
    expect(meta('property', 'og:type')).toBe('website');
    expect(meta('property', 'og:url')).toBe(SITE);
    expect(meta('property', 'og:image')).toBe(`${SITE}og-image.png`);
    expect(meta('property', 'og:image:width')).toBe('1200');
    expect(meta('property', 'og:image:height')).toBe('630');
  });

  it('has a plain one-sentence description that says on-device and that an account is optional', () => {
    const d = meta('property', 'og:description')!;
    expect(d).toMatch(/phone/);
    expect(d).toMatch(/audio never leaves/);
    expect(d).toMatch(/account is optional/);
    expect(d).not.toMatch(/!/);
    expect(d.trim().endsWith('.')).toBe(true);
    expect(meta('name', 'twitter:description')).toBe(d);
    expect(meta('name', 'description')).toBeDefined();
  });

  it('has the Twitter card tags, pointing at the same image', () => {
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
    expect(meta('name', 'twitter:title')).toBe('Sabih’s Birdbrain');
    expect(meta('name', 'twitter:image')).toBe(meta('property', 'og:image'));
  });

  it('ships the preview image at 1200×630', () => {
    const png = readFileSync(new URL('../public/og-image.png', import.meta.url));
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
    // Crawlers fetch it once; it must not be a multi-megabyte file.
    expect(png.length).toBeLessThan(400 * 1024);
  });

  it('keeps the preview image out of the service-worker precache', () => {
    expect(read('vite.config.ts')).toMatch(/globIgnores: \[[^\]]*'og-image\.png'/);
  });

  it('has static text and a noscript line inside #app, which mountApp replaces', () => {
    const app = html.match(/<div id="app">([\s\S]*?)<\/div>/)?.[1] ?? '';
    expect(app).toMatch(/<p>Birdbrain listens[^<]*<\/p>/);
    expect(app).toMatch(/<noscript><p>[^<]*JavaScript[^<]*<\/p><\/noscript>/);
    expect(app).not.toMatch(/<h1|style=/);
    // The app shell replaces the whole root, so the static text never sits under the UI.
    expect(read('src/ui/app.ts')).toMatch(/root\.replaceChildren\(/);
  });
});
