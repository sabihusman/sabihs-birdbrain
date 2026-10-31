/**
 * Birds the sound model matched above the confidence minimum but the location model does not expect here
 * (DECISIONS.md #93). They are not hidden in silence any more: Listen counts them behind one line, and a
 * "Keep this sighting" button saves one as a normal sighting, marked as verified by sound only.
 */
export const NOT_USUAL_SUBTITLE = 'Not usual here (location filter)';
export const KEEP_SIGHTING = 'Keep this sighting';
export const KEPT_SIGHTING = 'Kept';
/** Shown wherever a kept sighting is listed (Sabih's wording, shortened). */
export const SOUND_ONLY_NOTE = 'Verified by sound only, not location: this bird isn’t usually here.';
/** The short tag for one-line summaries and the CSV export. */
export const SOUND_ONLY_TAG = 'sound only';

/** "2 birds not usual here · show" / "Hide birds not usual here". */
export function notUsualToggleText(count: number, open: boolean): string {
  return open ? 'Hide birds not usual here' : `${count} bird${count === 1 ? '' : 's'} not usual here · show`;
}

/**
 * The one-line banner on Listen while listening (DECISIONS.md #103): what the location filter is doing right
 * now, and how many strong matches it held back. "Location on" is the default, so the banner says what the
 * filter does; the grey version says when it is doing nothing.
 */
export interface LocationBanner {
  kind: 'filter' | 'held' | 'locating' | 'none';
  text: string;
  /** "2 · show" / "2 · hide" when birds are held back. */
  count: string | null;
}

export function locationBanner(hasLocation: boolean, status: string, heldBack: number, open: boolean): LocationBanner {
  if (hasLocation) {
    if (heldBack > 0) return { kind: 'held', text: 'Not usual here:', count: `${heldBack} · ${open ? 'hide' : 'show'}` };
    return { kind: 'filter', text: 'Birds not usual here are held back', count: null };
  }
  if (status === 'locating' || status === 'idle') return { kind: 'locating', text: 'Finding your location…', count: null };
  return { kind: 'none', text: 'No location: every species can show', count: null };
}
