import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let release: Array<() => void> = [];
vi.mock('../src/species/wiki', () => ({
  getSpeciesSummary: (sp: { scientific: string }) => {
    calls.push(sp.scientific);
    return new Promise((resolve) => release.push(() => resolve({ status: 'ok', thumbnail: { source: `https://upload.wikimedia.org/${sp.scientific}.jpg` } })));
  },
}));

const { MAX_THUMB_LOOKUPS, speciesThumbnail } = await import('../src/ui/components/bird-thumb');
const sp = (scientific: string) => ({ scientific, common: scientific, index: 0, isBird: true }) as never;

describe('bird thumbnails', () => {
  it('looks up at most a few species at once, each species once, and resolves the Wikipedia thumbnail', async () => {
    const names = ['A a', 'B b', 'C c', 'D d', 'E e'];
    const results = names.map((n) => speciesThumbnail(sp(n)));
    void speciesThumbnail(sp('A a')); // repeat: served from the session cache
    await Promise.resolve();
    expect(calls).toHaveLength(MAX_THUMB_LOOKUPS);
    while (release.length) {
      const batch = release;
      release = [];
      batch.forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(calls).toEqual(names);
    expect(await results[4]).toBe('https://upload.wikimedia.org/E e.jpg');
  });
});
