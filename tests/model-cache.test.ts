import { describe, expect, it } from 'vitest';
import { staleModelEntries } from '../src/model/model-cache';

const REMOTE = 'https://bird-brain.duckdns.org/models/birdnet-v2.4/';

describe('model cache housekeeping (DECISIONS.md #56)', () => {
  it('keeps files from the current base URL', () => {
    const keep = [`${REMOTE}model.json`, `${REMOTE}group1-shard1of13.bin`, `${REMOTE}mdata/model.json`];
    expect(staleModelEntries(keep, REMOTE)).toEqual([]);
  });

  it('drops the copies served from the front end before the move', () => {
    const urls = [
      'https://sabihs-birdbrain.vercel.app/models/birdnet-v2.4/model.json',
      'https://sabihs-birdbrain.vercel.app/models/birdnet-v2.4/group1-shard1of13.bin',
      `${REMOTE}model.json`,
    ];
    expect(staleModelEntries(urls, REMOTE)).toEqual([urls[0], urls[1]]);
  });

  it('drops an older model version from the same host', () => {
    const urls = ['https://bird-brain.duckdns.org/models/birdnet-v2.3/model.json', `${REMOTE}model.json`];
    expect(staleModelEntries(urls, REMOTE)).toEqual([urls[0]]);
  });

  it('compares a relative base against absolute cache keys', () => {
    const urls = ['http://localhost:4173/models/birdnet-v2.4/model.json', 'http://localhost:4173/models/birdnet-v2.3/model.json'];
    expect(staleModelEntries(urls, '/models/birdnet-v2.4/')).toEqual([urls[1]]);
  });

  it('never deletes everything when the base URL is the one in use', () => {
    const urls = [`${REMOTE}model.json`];
    expect(staleModelEntries(urls, REMOTE)).toHaveLength(0);
  });
});
