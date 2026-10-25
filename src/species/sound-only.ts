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
