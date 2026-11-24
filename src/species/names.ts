/**
 * One bird, one name (DECISIONS.md #136). BirdNET+ V3.0 renamed or merged 297 of V2.4's birds ("Accipiter cooperii" is
 * "Astur cooperii"; Lesser and Hoary Redpoll are one "Redpoll"). Saved sightings, clips and friends' lists keep the
 * name they were saved under; this module decides which name the app shows for them, so a bird saved with either
 * model appears once, under the name of the model that runs. Nothing stored changes, so switching models back and
 * forth loses nothing.
 *
 * The table, `public/models/birdnet-v3.0/v24-names.json` (V2.4 name → V3.0 name), comes from
 * `scripts/prepare-names-v3.mts`. With V2.4 running, a V3.0 name goes back to its V2.4 name only when exactly one V2.4
 * name became it (a rename); after a merge, V3.0's name stays (V2.4 keeps its separate species).
 */
export interface NameView {
  /** The name to show for a stored name. */
  canonical(scientific: string): string;
  /** Every stored name that shows as `scientific`, itself first. */
  storedNames(scientific: string): string[];
}

export const IDENTITY_VIEW: NameView = { canonical: (s) => s, storedNames: (s) => [s] };

/** `v24ToV3`: the table. `toV3`: V3.0 runs (old names show as new); otherwise V2.4 runs (renames show as old). */
export function buildNameView(v24ToV3: Readonly<Record<string, string>>, toV3: boolean): NameView {
  const forward = new Map<string, string>();
  if (toV3) for (const [old, now] of Object.entries(v24ToV3)) forward.set(old, now);
  else {
    const sources = new Map<string, string[]>();
    for (const [old, now] of Object.entries(v24ToV3)) sources.set(now, [...(sources.get(now) ?? []), old]);
    for (const [now, olds] of sources) if (olds.length === 1) forward.set(now, olds[0]);
  }
  const back = new Map<string, string[]>();
  for (const [from, to] of forward) back.set(to, [...(back.get(to) ?? []), from]);
  return {
    canonical: (s) => forward.get(s) ?? s,
    storedNames: (s) => [s, ...(back.get(s) ?? [])],
  };
}

let current: NameView = IDENTITY_VIEW;

/** Set by the controller when the model and its table are loaded. */
export function setNameView(view: NameView): void {
  current = view;
}

export function canonicalName(scientific: string): string {
  return current.canonical(scientific);
}

export function storedNames(scientific: string): string[] {
  return current.storedNames(scientific);
}

let commonOf: (scientific: string) => string | undefined = () => undefined;

/** The running model's English name for a scientific name, set by the controller with the view. */
export function setCommonNames(fn: (scientific: string) => string | undefined): void {
  commonOf = fn;
}

/** A stored row as the app shows it: under the running model's name (and English name), unchanged otherwise. */
export function renamed<T extends { scientific: string; common: string; label?: string }>(row: T): T {
  const scientific = canonicalName(row.scientific);
  if (scientific === row.scientific) return row;
  const common = commonOf(scientific) ?? row.common;
  return { ...row, scientific, common, ...(row.label === undefined ? {} : { label: `${scientific}_${common}` }) };
}
