export interface Species {
  /** Index into the model output vector. */
  index: number;
  /** Raw BirdNET label, "Scientific name_Common name". */
  label: string;
  scientific: string;
  common: string;
  /** False for BirdNET's non-event classes such as "Dog", "Engine", "Noise". */
  isBird: boolean;
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
