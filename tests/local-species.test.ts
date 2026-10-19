import { describe, expect, it } from 'vitest';
import type { Species } from '../src/model/labels';
import { describeLocalCount, filterLocal, haversineKm, LOCAL_RECOMPUTE_KM, localIndices, LocalSpeciesCache, maxOverWeeks } from '../src/species/local';

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

const sp = (index: number, name: string): Species => ({ index, label: `${name}_${name}`, scientific: name, common: name, isBird: true });
const ALL = [sp(0, 'A a'), sp(1, 'B b'), sp(2, 'C c'), sp(3, 'D d')];

describe('local species: geo scores over the year', () => {
  it('takes the per-species maximum over the 48 weeks and applies the threshold', () => {
    // 3 weeks × 4 species, row-major
    const probs = [0.01, 0.5, 0.0, 0.02, 0.04, 0.1, 0.0, 0.02, 0.02, 0.2, 0.0, 0.031];
    const max = maxOverWeeks(probs, 3, 4);
    expect(Array.from(max).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.04, 0.5, 0, 0.031]);
    expect(localIndices(max, 0.03)).toEqual(new Set([0, 1, 3])); // species 0 only in one week still counts
    expect(localIndices(max, 0.05)).toEqual(new Set([1]));
  });

  it('recomputes only after moving more than 25 km, and survives a reload', () => {
    const storage = new MemoryStorage();
    const cache = new LocalSpeciesCache(storage);
    expect(cache.needsRecompute(52.52, 13.405)).toBe(true); // nothing cached
    cache.set({ lat: 52.52, lon: 13.405, maxProbs: Float32Array.from([0.5, 0.01]), computedAt: 1 });
    expect(cache.needsRecompute(52.52, 13.405)).toBe(false);
    expect(cache.needsRecompute(52.6, 13.5)).toBe(false); // ~11 km
    expect(cache.needsRecompute(52.9, 13.405)).toBe(true); // ~42 km
    expect(haversineKm(52.52, 13.405, 52.9, 13.405)).toBeGreaterThan(LOCAL_RECOMPUTE_KM);
    const reloaded = new LocalSpeciesCache(storage);
    expect(reloaded.current?.lat).toBe(52.52);
    expect(Array.from(reloaded.current!.maxProbs).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.5, 0.01]);
    expect(reloaded.needsRecompute(52.52, 13.405)).toBe(false);
  });
});

describe('local species: what the Species tab shows', () => {
  it('shows local species by default, all on request, with the count line', () => {
    const local = new Set([1, 3]);
    const r = filterLocal(ALL, local, false, null);
    expect(r.shown.map((s) => s.index)).toEqual([1, 3]);
    expect(describeLocalCount(r)).toBe('2 local species · 4 total');
    expect(r.note).toBeNull();
    const all = filterLocal(ALL, local, true, null);
    expect(all.shown.length).toBe(4);
    expect(describeLocalCount(all)).toBe('2 local species · 4 total');
  });

  it('falls back to every species with a note when no location is available', () => {
    const r = filterLocal(ALL, null, false, 'Showing all species: no location is available (denied).');
    expect(r.shown.length).toBe(4);
    expect(r.localCount).toBeNull();
    expect(r.note).toMatch(/no location/);
    expect(describeLocalCount(r)).toBe('4 species');
    expect(filterLocal(ALL, null, false, null).note).toMatch(/no location is available/);
  });
});
