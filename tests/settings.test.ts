import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/app/settings';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  key(i: number) {
    return Array.from(this.m.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('SettingsStore', () => {
  it('persists the threshold and clamps bad values', () => {
    const storage = new MemoryStorage();
    const s = new SettingsStore(storage);
    expect(s.get().threshold).toBe(DEFAULT_SETTINGS.threshold);
    s.update({ threshold: 0.6 });
    expect(new SettingsStore(storage).get().threshold).toBe(0.6);
    s.update({ threshold: 5 });
    expect(s.get().threshold).toBe(0.99);
    s.update({ manualLat: 200 });
    expect(s.get().manualLat).toBe(90);
  });

  it('notifies listeners', () => {
    const s = new SettingsStore(new MemoryStorage());
    let seen = 0;
    s.on('change', () => seen++);
    s.update({ autoSaveClips: true });
    expect(seen).toBe(1);
  });

  it('survives corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('birdbrain.settings.v1', '{not json');
    expect(new SettingsStore(storage).get()).toEqual(DEFAULT_SETTINGS);
  });
});
