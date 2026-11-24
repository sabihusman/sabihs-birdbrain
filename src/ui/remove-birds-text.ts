import type { RemovalPlan } from '../storage/db';

/** The words of "Remove from my birds" and of deleting a recording (DECISIONS.md #138), apart so tests can read them. */

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a, b and c". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What else goes, as a phrase: "2 auto-saved clips and its sound clip", or "" when nothing does. */
function extras(plan: RemovalPlan, clipWord: string): string {
  const parts: string[] = [];
  if (plan.autoClips.length) parts.push(count(plan.autoClips.length, 'auto-saved clip'));
  if (plan.speciesClips.length) parts.push(clipWord);
  return listNames(parts);
}

export const REMOVE_SPECIES_BUTTON = 'Remove from my birds';

export function speciesRemovalText(common: string, plan: RemovalPlan): { title: string; lines: string[]; confirm: string } {
  const more = extras(plan, 'its sound clip');
  return {
    title: `Remove the ${common} from your birds?`,
    lines: [
      `Takes away ${count(plan.sightings, 'sighting')}${more ? ` and ${more}` : ''} on this phone, for example after a bird video played nearby.`,
      'Recordings you made or imported stay; analysing one again can find it again.',
    ],
    confirm: 'Remove',
  };
}

export const DELETE_RECORDING_TITLE = 'Delete this recording?';

/** No listen behind it, or nothing else from it: the plain question. */
export const DELETE_RECORDING_ONLY = { lines: ['Removes the recording and the birds found in it.'], confirm: 'Delete' };

/**
 * The recording came from a listen that heard the same birds in other windows: offer those too. `names` are the birds'
 * common names in the running model.
 */
export function listenRemovalText(plan: RemovalPlan, names: readonly string[]): { lines: string[]; both: string; one: string } {
  const more = extras(plan, 'a sound clip');
  // Counted in 3 s windows ("times"): the recording's own sighting usually holds the other windows too, so a count of
  // sightings removed would often read 0.
  return {
    lines: [
      `The same listen heard the ${listNames(names)} ${count(plan.detections, 'more time')}${more ? `, with ${more}` : ''}.`,
      'If they were not real birds (a video or a recording playing nearby), remove them too.',
    ],
    both: `Delete it and the rest of that listen’s ${listNames(names)}`,
    one: 'Delete only this recording',
  };
}
