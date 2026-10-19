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

/** Coordinates and Plus Code with copy buttons and a Google Maps link. */
export function locationBlock(lat: number, lon: number, opts: { accuracy?: number | null; compact?: boolean } = {}): HTMLElement {
  const coords = formatLatLon(lat, lon);
  const code = plusCode(lat, lon);
  const copyCoords = el('button', { class: 'btn small', type: 'button', 'aria-label': 'Copy coordinates' }, 'Copy');
  copyCoords.addEventListener('click', () => void copyText(coords, copyCoords));
  const copyCode = el('button', { class: 'btn small', type: 'button', 'aria-label': 'Copy Plus Code' }, 'Copy');
  copyCode.addEventListener('click', () => void copyText(code, copyCode));
  return el(
    'div',
    { class: `location-block${opts.compact ? ' compact' : ''}` },
    el('div', { class: 'row between' }, el('span', null, el('span', { class: 'muted small' }, 'Coordinates '), el('code', null, coords), opts.accuracy ? el('span', { class: 'muted small' }, ` ±${Math.round(opts.accuracy)} m`) : null), copyCoords),
    el('div', { class: 'row between' }, el('span', null, el('span', { class: 'muted small' }, 'Plus Code '), el('code', null, code)), copyCode),
    el('a', { class: 'small', href: googleMapsUrl(lat, lon), target: '_blank', rel: 'noopener noreferrer' }, 'Open in Google Maps'),
  );
}
