import { V3_SOUND_GROUPS } from './v3';
export interface Species {
  /** Index into the model output vector. */
  index: number;
  /** Raw BirdNET label, "Scientific name_Common name". */
  label: string;
  scientific: string;
  common: string;
  /** False for BirdNET's non-event classes such as "Dog", "Engine", "Noise" (and, with V3.0, frogs, insects, mammals …). */
  isBird: boolean;
  /** V3.0 only: the taxon group (Aves, Amphibia, Insecta, …, or Anthropogenic / Geophony / Music for sound classes). */
  group?: string;
}

/**
 * BirdNET+ V3.0's labels.json (DECISIONS.md #133): one row per output of the audio model. Birds are the rows whose
 * taxon group is Aves; the maps go to the worker so it can line the location model's output up with these rows.
 */
export function parseV3Labels(json: { classes: ReadonlyArray<readonly [string, string, string, number]> }): { species: Species[]; geoIndex: Int32Array; soundClass: Uint8Array } {
  const species = json.classes.map(([scientific, common, group], index) => ({ index, label: `${scientific}_${common}`, scientific, common, isBird: group === 'Aves', group }));
  const geoIndex = Int32Array.from(json.classes, (c) => c[3]);
  const soundClass = Uint8Array.from(json.classes, (c) => (V3_SOUND_GROUPS.has(c[2]) ? 1 : 0));
  return { species, geoIndex, soundClass };
}

/**
 * Names from the other model that the current one does not have (V2.4's "Accipiter cooperii" is "Astur cooperii" in
 * V3.0), so a bird saved with V2.4 still has a name and a page while V3.0 runs. Index -1: no output of the running
 * model belongs to them, so they can never be detected or analysed with it.
 */
export function lookupOnly(other: readonly Species[], current: ReadonlyMap<string, Species>): Species[] {
  return other.filter((s) => !current.has(s.scientific)).map((s) => ({ ...s, index: -1 }));
}

/** Parse the BirdNET label list ("Scientific_Common" per entry, index = class id). */
export function parseLabels(labels: string[]): Species[] {
  return labels.map((label, index) => {
    const i = label.indexOf('_');
    const scientific = i >= 0 ? label.slice(0, i) : label;
    const common = i >= 0 ? label.slice(i + 1) : label;
    return { index, label, scientific, common, isBird: scientific !== common };
  });
}

/** Split a raw label into its two names without needing the species list. */
export function splitLabel(label: string): { scientific: string; common: string } {
  const i = label.indexOf('_');
  if (i < 0) return { scientific: label, common: label };
  return { scientific: label.slice(0, i), common: label.slice(i + 1) };
}

export function normalizeForSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .toLowerCase();
}

/**
 * Rank species for a search query: prefix matches on the common name first,
 * then word-prefix matches, then any substring of either name.
 */
export function searchSpecies(list: Species[], query: string, limit = 50): Species[] {
  const q = normalizeForSearch(query.trim());
  if (!q) return list.slice(0, limit);
  const scored: Array<[number, Species]> = [];
  for (const s of list) {
    const common = normalizeForSearch(s.common);
    const sci = normalizeForSearch(s.scientific);
    let score = -1;
    if (common.startsWith(q)) score = 0;
    else if (common.split(/[\s-]+/).some((w) => w.startsWith(q))) score = 1;
    else if (sci.startsWith(q)) score = 2;
    else if (common.includes(q)) score = 3;
    else if (sci.includes(q)) score = 4;
    if (score >= 0) scored.push([score, s]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].common.localeCompare(b[1].common));
  return scored.slice(0, limit).map(([, s]) => s);
}
