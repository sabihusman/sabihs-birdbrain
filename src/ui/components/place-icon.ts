import { el } from '../dom';

/** A map pin drawn in the text colour (stroke only, so it reads in both themes). DECISIONS.md #73. */
const PIN = '<path d="M12 21s-6-6-6-11a6 6 0 0112 0c0 5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>';

/** 48 px tile with a pin; decorative (the card says the place's name in words). */
export function placeIcon(): HTMLElement {
  const box = el('span', { class: 'place-icon', 'aria-hidden': 'true' });
  box.innerHTML = `<svg viewBox="0 0 24 24">${PIN}</svg>`;
  return box;
}
