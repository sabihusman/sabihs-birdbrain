import { existsSync, readFileSync } from 'node:fs';

export interface SpeciesLabels {
  /** scientific name -> common name */
  byScientific: Map<string, string>;
  has(scientific: string): boolean;
}

export function parseLabels(entries: string[]): SpeciesLabels {
  const byScientific = new Map<string, string>();
  for (const label of entries) {
    const i = label.indexOf('_');
    if (i <= 0) continue;
    const scientific = label.slice(0, i);
    const common = label.slice(i + 1);
    if (scientific !== common) byScientific.set(scientific, common);
  }
  return { byScientific, has: (s) => byScientific.has(s) };
}

/** Sound classes in BirdNET+ V3.0's list (gun, siren, music …): not animals, so nothing to ask about. */
const V3_SOUND_GROUPS = new Set(['Anthropogenic', 'Geophony', 'Music']);

/**
 * Add BirdNET+ V3.0's names (public/models/birdnet-v3.0/labels.json: rows of [scientific, common, group, geo index])
 * to V2.4's, so "Ask about this bird" knows a bird whichever model found it (DECISIONS.md #136). A name both lists
 * have keeps V2.4's English name; V3.0 adds its new and renamed species (frogs and insects too, not its sound classes).
 */
export function addV3Labels(labels: SpeciesLabels, json: unknown): SpeciesLabels {
  const classes = (json as { classes?: unknown })?.classes;
  if (!Array.isArray(classes)) throw new Error('V3.0 labels must have a classes array');
  const byScientific = new Map(labels.byScientific);
  for (const row of classes as unknown[]) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string' || typeof row[2] !== 'string') continue;
    const [scientific, common, group] = row as [string, string, string];
    if (V3_SOUND_GROUPS.has(group) || byScientific.has(scientific)) continue;
    byScientific.set(scientific, common);
  }
  return { byScientific, has: (s) => byScientific.has(s) };
}

/** V2.4's labels.json, plus V3.0's when `v3Path` exists (the image has both; a bare checkout may not). */
export function loadLabels(path: string, v3Path?: string): SpeciesLabels {
  const json = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(json) || !json.every((x) => typeof x === 'string')) throw new Error('labels.json must be an array of strings');
  const labels = parseLabels(json);
  return v3Path && existsSync(v3Path) ? addV3Labels(labels, JSON.parse(readFileSync(v3Path, 'utf8'))) : labels;
}
