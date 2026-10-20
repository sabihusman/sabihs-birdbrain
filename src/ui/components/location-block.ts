import { describeAccuracy, isApproximate, isLegacyPosition, looksImprecise } from '../../app/position-watch';
import { formatLatLon, googleMapsUrl, plusCode } from '../../geo/pluscode';
import { el } from '../dom';

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

export const PLUS_CODE_HELP = "Google's short code for this spot; works in Google Maps.";

/** iOS gives no flag for Precise Location; an accuracy of a kilometre or more is the clue. */
export const IMPRECISE_HINT = 'This looks like Precise Location is off for this app. iPhone: Settings › Privacy & Security › Location Services › Sabih’s Birdbrain › Precise Location.';
/** Rows saved before the fix time was stored could have come from the start of the session. */
export const LEGACY_POSITION_NOTE = 'Saved before the app followed your position: location may be from session start.';

/**
 * Coordinates with a copy button and a Google Maps link; the Plus Code sits in
 * a collapsed "More location details" row with one line saying what it is.
 * A map preview, when wanted, goes above this block (see map-preview.ts).
 */
/**
 * `fixTime` and `time` are what decide whether the position is only approximate
 * (DECISIONS.md #58): the age of the fix at the moment of the detection, plus its accuracy.
 * Without them the row predates the change and says so.
 */
export function locationBlock(lat: number, lon: number, opts: { accuracy?: number | null; fixTime?: number | null; time?: number; compact?: boolean } = {}): HTMLElement {
  const stamp = { accuracy: opts.accuracy ?? null, fixTime: opts.fixTime ?? null };
  const at = opts.time ?? Date.now();
  const reading = describeAccuracy(stamp, at);
  const rough = isApproximate(stamp, at);
  const legacy = isLegacyPosition(stamp);
  const coords = formatLatLon(lat, lon);
  const code = plusCode(lat, lon);
  const copyCoords = el('button', { class: 'btn small', type: 'button', 'aria-label': 'Copy coordinates' }, 'Copy');
  copyCoords.addEventListener('click', () => void copyText(coords, copyCoords));
  const copyCode = el('button', { class: 'btn small', type: 'button', 'aria-label': 'Copy Plus Code' }, 'Copy');
  copyCode.addEventListener('click', () => void copyText(code, copyCode));
  return el(
    'div',
    { class: `location-block${opts.compact ? ' compact' : ''}`, 'data-testid': 'location-block' },
    el(
      'div',
      { class: 'row between' },
      el('span', null, el('span', { class: 'muted small' }, 'Coordinates '), el('code', null, coords), reading ? el('span', { class: `small${rough ? ' approx' : ' muted'}`, 'data-testid': 'location-accuracy' }, ` ${reading}`) : null),
      copyCoords,
    ),
    legacy ? el('p', { class: 'small muted', style: 'margin:2px 0 0', 'data-testid': 'location-legacy' }, LEGACY_POSITION_NOTE) : null,
    looksImprecise(stamp) ? el('p', { class: 'small muted', style: 'margin:2px 0 0', 'data-testid': 'location-imprecise' }, IMPRECISE_HINT) : null,
    el('a', { class: 'small', href: googleMapsUrl(lat, lon), target: '_blank', rel: 'noopener noreferrer' }, 'Open in Google Maps'),
    el(
      'details',
      { class: 'location-more', 'data-testid': 'location-more' },
      el('summary', null, 'More location details'),
      el('div', { class: 'row between' }, el('span', null, el('span', { class: 'muted small' }, 'Plus Code '), el('code', null, code)), copyCode),
      el('p', { class: 'small muted', style: 'margin:2px 0 0' }, PLUS_CODE_HELP),
    ),
  );
}
