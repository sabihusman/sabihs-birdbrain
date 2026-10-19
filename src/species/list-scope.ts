import type { Species } from '../model/labels';
import { describeLocalCount, filterLocal } from './local';
import { countSpotted, filterSpotted, isSpotted, type SpottedSet } from './spotted';

/** Everything the Species tab's list depends on (DECISIONS.md #41 and #43). */
export interface ListScopeInput {
  /** Bird (and, when enabled, non-bird) species in label order. */
  all: Species[];
  localIndices: Set<number> | null;
  localNote: string | null;
  showAll: boolean;
  spotted: SpottedSet;
  spottedOnly: boolean;
  /** Scientific names any accepted friend has shared; empty when signed out. */
  friendSpecies: ReadonlySet<string>;
  friendsAvailable: boolean;
  friendsOnly: boolean;
  /** Friends with a shared list (for the empty-state note). */
  friendCount: number;
}

export interface ListScope {
  /** The species to list before the search box narrows them. */
  shown: Species[];
  /** The count line above the list. */
  line: string;
  /** The note under it, or null when there is none. */
  note: string | null;
  /** Counts on the two filter chips ('' while the list is still loading or the chip is hidden). */
  spottedCount: string;
  friendsCount: string;
  /** "Spotted by friends" is only meaningful for a signed-in member. */
  friendsOnly: boolean;
}

/**
 * Pure: which species the Species tab shows and what the count line and note
 * say. "Spotted by me" and "Spotted by friends" bypass the local scope (a bird
 * heard on a trip is still one you spotted) and combine with OR.
 */
export function scopeSpeciesList(input: ListScopeInput): ListScope {
  const { all, spotted, friendSpecies } = input;
  const friendsOnly = input.friendsAvailable && input.friendsOnly;
  const spottedOnly = input.spottedOnly;
  const local = filterLocal(all, input.localIndices, input.showAll, input.localNote);
  const shown = selectSpecies(all, local.shown, spotted, friendSpecies, spottedOnly, friendsOnly);
  const total = all.length;
  const loaded = total > 0;
  let line = '';
  if (loaded) {
    const sub = subjectOf(spottedOnly, friendsOnly);
    line = sub ? `${shown.length.toLocaleString()} species spotted by ${sub} · ${total.toLocaleString()} total` : describeLocalCount(local);
  }
  return {
    shown,
    line,
    note: noteFor(spottedOnly, friendsOnly, input.friendCount, local.note),
    spottedCount: loaded ? String(countSpotted(all, spotted)) : '',
    friendsCount: loaded && input.friendsAvailable ? String(all.filter((s) => friendSpecies.has(s.scientific)).length) : '',
    friendsOnly,
  };
}

function selectSpecies(all: Species[], localShown: Species[], spotted: SpottedSet, friendSpecies: ReadonlySet<string>, spottedOnly: boolean, friendsOnly: boolean): Species[] {
  if (spottedOnly && friendsOnly) return all.filter((s) => isSpotted(s, spotted) || friendSpecies.has(s.scientific));
  if (spottedOnly) return filterSpotted(all, spotted, true);
  if (friendsOnly) return all.filter((s) => friendSpecies.has(s.scientific));
  return localShown;
}

function subjectOf(spottedOnly: boolean, friendsOnly: boolean): string | null {
  if (spottedOnly && friendsOnly) return 'you or your friends';
  if (spottedOnly) return 'you';
  if (friendsOnly) return 'your friends';
  return null;
}

function noteFor(spottedOnly: boolean, friendsOnly: boolean, friendCount: number, localNote: string | null): string | null {
  if (spottedOnly && friendsOnly) return 'Showing every species you or a friend have spotted, local or not.';
  if (spottedOnly) return 'Showing every species you have a sighting of on this device, local or not.';
  if (friendsOnly) return friendCount ? 'Showing every species a friend has shared, local or not. Friends share only the bird and the day they last spotted it.' : 'No friend has shared a list yet. Add friends in Settings › Account.';
  return localNote;
}
