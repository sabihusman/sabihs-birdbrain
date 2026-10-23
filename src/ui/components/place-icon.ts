import type { PlaceKind } from '../../geo/places';
import { el } from '../dom';

/** Simple line icons drawn in the text colour (stroke only, so they read in both themes). */
const PATHS: Record<PlaceKind | 'other', string> = {
  // A round tree on a trunk.
  park: '<circle cx="12" cy="9" r="5"/><path d="M12 14v7M9 21h6"/>',
  // A leaf with its midrib.
  reserve: '<path d="M5 19C5 10 11 5 20 4c0 9-5 15-14 15z"/><path d="M5 19l9-9"/>',
  // A flower on a stem.
  garden: '<circle cx="12" cy="8" r="2.5"/><path d="M12 5.5V3M12 13v-2.5M9.5 8H7M17 8h-2.5M12 13v8M12 17c-2 0-4-1-5-3M12 18c2 0 4-1 5-3"/>',
  // Two pointed trees.
  wood: '<path d="M7 3l-4 9h8zM7 12v8M16 6l-4 9h8zM16 15v5"/>',
  // A winding path.
  trail: '<path d="M8 21c0-4 8-4 8-8s-8-4-8-8"/><circle cx="8" cy="3" r="1"/>',
  // A map pin.
  other: '<path d="M12 21s-6-6-6-11a6 6 0 0112 0c0 5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
};

/** 48 px tile with the kind's icon; decorative (the kind is also written in words). */
export function placeIcon(kind: PlaceKind | 'other'): HTMLElement {
  const box = el('span', { class: 'place-icon', 'aria-hidden': 'true', 'data-kind': kind });
  box.innerHTML = `<svg viewBox="0 0 24 24">${PATHS[kind]}</svg>`;
  return box;
}
