import { describe, expect, it } from 'vitest';
import type { Species } from '../src/model/labels';
import { scopeSpeciesList, type ListScopeInput } from '../src/species/list-scope';

const sp = (index: number, scientific: string): Species => ({ index, label: `${scientific}_X`, scientific, common: `Common ${index}`, isBird: true });
const ALL = [sp(0, 'A a'), sp(1, 'B b'), sp(2, 'C c'), sp(3, 'D d')];
const base: ListScopeInput = { all: ALL, localIndices: new Set([0, 1]), localNote: null, showAll: false, spotted: new Set(['B b', 'C c']), spottedOnly: false, friendSpecies: new Set(['C c', 'D d']), friendsAvailable: true, friendsOnly: false, friendCount: 1 };
const names = (s: { shown: Species[] }) => s.shown.map((x) => x.scientific);

describe('scopeSpeciesList', () => {
  it('defaults to the local scope with chip counts', () => {
    const s = scopeSpeciesList(base);
    expect(names(s)).toEqual(['A a', 'B b']);
    expect(s.line).toBe('2 local species · 4 total');
    expect(s.note).toBeNull();
    expect(s.spottedCount).toBe('2');
    expect(s.friendsCount).toBe('2');
    expect(s.friendsOnly).toBe(false);
  });

  it('"Spotted by me" and "Spotted by friends" bypass the local scope and combine with OR', () => {
    const me = scopeSpeciesList({ ...base, spottedOnly: true });
    expect(names(me)).toEqual(['B b', 'C c']);
    expect(me.line).toBe('2 species spotted by you · 4 total');
    expect(me.note).toBe('Every species you’ve spotted, anywhere.');
    const fr = scopeSpeciesList({ ...base, friendsOnly: true });
    expect(names(fr)).toEqual(['C c', 'D d']);
    expect(fr.line).toBe('2 species spotted by your friends · 4 total');
    expect(fr.note).toBe('Every species a friend has shared, anywhere. They share only the bird and the last day seen.');
    const both = scopeSpeciesList({ ...base, spottedOnly: true, friendsOnly: true });
    expect(names(both)).toEqual(['B b', 'C c', 'D d']);
    expect(both.line).toBe('3 species spotted by you or your friends · 4 total');
    expect(both.note).toMatch(/you or a friend/);
  });

  it('friends-only is ignored when signed out, and the empty-state note points to Settings', () => {
    const out = scopeSpeciesList({ ...base, friendsOnly: true, friendsAvailable: false, friendSpecies: new Set() });
    expect(out.friendsOnly).toBe(false);
    expect(names(out)).toEqual(['A a', 'B b']);
    expect(out.friendsCount).toBe('');
    const none = scopeSpeciesList({ ...base, friendsOnly: true, friendSpecies: new Set(), friendCount: 0 });
    expect(names(none)).toEqual([]);
    expect(none.note).toBe('No friend has shared yet. Add friends in Settings › Account.');
  });

  it('keeps the location note and shows nothing while the list is still loading', () => {
    const noLoc = scopeSpeciesList({ ...base, localIndices: null, localNote: 'No position.' });
    expect(names(noLoc)).toHaveLength(4);
    expect(noLoc.note).toBe('No position.');
    const loading = scopeSpeciesList({ ...base, all: [] });
    expect(loading.line).toBe('');
    expect(loading.spottedCount).toBe('');
    expect(loading.friendsCount).toBe('');
  });
});

describe('which Species notes may fold (DECISIONS.md #100)', () => {
  it('explanations fold; a reason the list differs or a next step stays in view', () => {
    expect(scopeSpeciesList({ ...base, spottedOnly: true }).noteKind).toBe('info');
    expect(scopeSpeciesList({ ...base, friendsOnly: true }).noteKind).toBe('info');
    expect(scopeSpeciesList({ ...base, friendsOnly: true, friendCount: 0 }).noteKind).toBe('status');
    expect(scopeSpeciesList({ ...base, localIndices: null, localNote: 'All species: location filter off (Settings › Location).' }).noteKind).toBe('status');
  });
});
