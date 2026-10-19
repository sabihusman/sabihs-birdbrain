import type { Species } from '../model/labels';
import { listSightedSpecies } from '../storage/db';

/**
 * "Spotted" species: those with at least one sighting in this device's
 * IndexedDB, keyed by scientific name (the key the sightings store indexes).
 * Nothing leaves the device; the set is rebuilt whenever detections change.
 */
export type SpottedSet = ReadonlySet<string>;

export function spottedSet(scientifics: Iterable<string>): Set<string> {
  const s = new Set<string>();
  for (const name of scientifics) if (name) s.add(name);
  return s;
}

export async function loadSpottedSet(): Promise<Set<string>> {
  return spottedSet(await listSightedSpecies());
}

export function isSpotted(species: Pick<Species, 'scientific'>, spotted: SpottedSet): boolean {
  return spotted.has(species.scientific);
}

/**
 * The "Spotted by me" chip: when on, keep only species with a sighting. The
 * caller passes the list it would otherwise show; the local/show-all scope is
 * bypassed by the caller when the chip is on (a bird you heard on a trip is
 * still one you spotted).
 */
export function filterSpotted<T extends Pick<Species, 'scientific'>>(list: readonly T[], spotted: SpottedSet, on: boolean): T[] {
  return on ? list.filter((s) => isSpotted(s, spotted)) : list.slice();
}

/** How many of `list` carry a tick. */
export function countSpotted(list: readonly Pick<Species, 'scientific'>[], spotted: SpottedSet): number {
  let n = 0;
  for (const s of list) if (isSpotted(s, spotted)) n++;
  return n;
}
