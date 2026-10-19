import { readFileSync } from 'node:fs';

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

export function loadLabels(path: string): SpeciesLabels {
  const json = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(json) || !json.every((x) => typeof x === 'string')) throw new Error('labels.json must be an array of strings');
  return parseLabels(json);
}
