import { describe, expect, it } from 'vitest';
import { isModelCached, markModelWanted, MODEL_WANTED_KEY, readStoredSignals, readVisitSignals, shouldShowWelcome, type ModelCacheStorage } from '../src/app/first-visit';
import { SETTINGS_KEY } from '../src/app/settings';
import { MODEL_CACHE_NAME } from '../src/model/constants';
import { MemoryStorage } from './helpers/memory-storage';

const REMOTE = 'https://bird-brain.duckdns.org/models/birdnet-v2.4/';

/** A CacheStorage with one bucket holding the given URLs. */
function fakeCaches(bucket: string | null, urls: string[]): ModelCacheStorage {
  return {
    has: async (name) => name === bucket,
    open: async (name) => ({ match: async (req) => (name === bucket && urls.includes(String(req)) ? new Response('x') : undefined) }),
  };
}

describe('welcome layer: first visit or returning visitor (DECISIONS.md #68)', () => {
  it('shows the welcome only when nothing says the phone has used Birdbrain before', () => {
    expect(shouldShowWelcome({ settingsStored: false, modelWanted: false, modelCached: false })).toBe(true);
    expect(shouldShowWelcome({ settingsStored: true, modelWanted: false, modelCached: false })).toBe(false);
    expect(shouldShowWelcome({ settingsStored: false, modelWanted: true, modelCached: false })).toBe(false);
    expect(shouldShowWelcome({ settingsStored: false, modelWanted: false, modelCached: true })).toBe(false);
  });

  it('reads the two localStorage signals and treats a broken storage as empty', () => {
    const storage = new MemoryStorage();
    expect(readStoredSignals(storage)).toEqual({ settingsStored: false, modelWanted: false });
    storage.setItem(SETTINGS_KEY, '{}');
    expect(readStoredSignals(storage).settingsStored).toBe(true);
    markModelWanted(storage);
    expect(storage.getItem(MODEL_WANTED_KEY)).toBe('wanted');
    expect(readStoredSignals(storage).modelWanted).toBe(true);
    expect(readStoredSignals(null)).toEqual({ settingsStored: false, modelWanted: false });
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readStoredSignals(throwing)).toEqual({ settingsStored: false, modelWanted: false });
    expect(() => markModelWanted(throwing)).not.toThrow();
  });

  it('looks for the acoustic model.json in the model cache, guarded for browsers without Cache Storage', async () => {
    expect(await isModelCached(undefined, REMOTE)).toBe(false);
    expect(await isModelCached(fakeCaches(null, []), REMOTE)).toBe(false);
    expect(await isModelCached(fakeCaches(MODEL_CACHE_NAME, [`${REMOTE}group1-shard1of13.bin`]), REMOTE)).toBe(false); // a partial download does not count
    expect(await isModelCached(fakeCaches(MODEL_CACHE_NAME, [`${REMOTE}model.json`]), REMOTE)).toBe(true);
    const broken: ModelCacheStorage = {
      has: async () => {
        throw new Error('SecurityError');
      },
      open: async () => ({ match: async () => undefined }),
    };
    expect(await isModelCached(broken, REMOTE)).toBe(false);
  });

  it('combines all three signals', async () => {
    const storage = new MemoryStorage();
    expect(await readVisitSignals(storage, fakeCaches(null, []), REMOTE)).toEqual({ settingsStored: false, modelWanted: false, modelCached: false });
    expect(await readVisitSignals(storage, fakeCaches(MODEL_CACHE_NAME, [`${REMOTE}model.json`]), REMOTE)).toMatchObject({ modelCached: true });
  });
});
