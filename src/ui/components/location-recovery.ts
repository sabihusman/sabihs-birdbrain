import type { AppController } from '../../app/controller';
import { searchPlaces as defaultSearch, type PlaceMatch, type PlaceSearchResult } from '../../geo/place-search';
import { el } from '../dom';

/**
 * Species with no location (DECISIONS.md #105, UI/UX audit finding 2): one banner that says the list is the
 * whole world, with "Use my location" (asks again) and "Pick a place" (a town search; the place becomes the
 * manual location). When the phone keeps refusing, it says how to allow location. With a picked place, one
 * line names it with a way to change it. Nothing asks for latitude and longitude.
 */
export const RECOVERY_TEXT = {
  worldTitle: 'Showing every species in the world.',
  worldBody: 'Share your location, or pick a place, to see the birds found there.',
  blockedTitle: 'Your phone is blocking location for this site.',
  blockedSafari: 'Safari: tap “aA” in the address bar › Website Settings › Location › Allow.',
  blockedChrome: 'Chrome: iPhone Settings › Apps › Chrome › Location › While Using.',
  finding: 'Finding your location…',
  privacy: 'The name you type goes to OpenStreetMap to find the place. Only the place you choose is kept, on this phone.',
} as const;

/** "Ithaca, New York": the name plus the first part of the second line. */
export function placeName(p: Pick<PlaceMatch, 'name' | 'line2'>): string {
  const region = p.line2.split(',')[0]?.trim();
  return region ? `${p.name}, ${region}` : p.name;
}

export function locationRecovery(controller: AppController, search: (q: string) => Promise<PlaceSearchResult> = defaultSearch): { el: HTMLElement; render: () => void; dispose: () => void } {
  const settings = controller.settings;
  const root = el('div', { 'data-testid': 'species-location' });
  /** The open picker, kept while it is open so a location change never wipes what was typed. */
  let pickerEl: HTMLElement | null = null;

  const usePosition = () => {
    pickerEl = null;
    if (settings.get().locationMode !== 'auto') settings.update({ locationMode: 'auto' });
    else void controller.location.refresh();
    render();
  };
  const choose = (p: PlaceMatch) => {
    pickerEl = null;
    settings.update({ locationMode: 'manual', manualLat: p.lat, manualLon: p.lon, manualPlace: placeName(p) });
  };

  const picker = () => {
    const input = el('input', { class: 'search', type: 'search', placeholder: 'Town or city', 'aria-label': 'Town or city', autocomplete: 'off', 'data-testid': 'place-query' });
    const go = el('button', { class: 'btn primary', type: 'submit', 'data-testid': 'place-search' }, 'Search');
    const results = el('div', { class: 'place-results', 'data-testid': 'place-results' });
    const status = el('p', { class: 'small muted', role: 'status', style: 'margin:0' }, '');
    const cancel = el('button', { class: 'btn small text', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => {
      pickerEl = null;
      render();
    });
    const form = el('form', { class: 'stack place-picker' }, el('strong', null, 'Pick a place'), el('div', { class: 'row' }, el('div', { style: 'flex:1;min-width:0' }, input), go), status, results, el('p', { class: 'small muted', style: 'margin:0' }, RECOVERY_TEXT.privacy), el('div', null, cancel));
    // One search per press of Search: Nominatim does not allow search-as-you-type.
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      status.textContent = 'Searching…';
      results.replaceChildren();
      const r = await search(input.value);
      go.disabled = false;
      if (r.status === 'too-short') status.textContent = 'Type at least two letters.';
      else if (r.status === 'offline') status.textContent = 'Searching needs a connection.';
      else if (r.status === 'busy') status.textContent = 'The place search is busy. Try again in a moment.';
      else if (r.places.length === 0) status.textContent = 'No place found by that name.';
      else {
        status.textContent = '';
        results.replaceChildren(
          ...r.places.map((p) => {
            const b = el('button', { class: 'place-result', type: 'button', 'data-testid': 'place-result' }, el('span', null, p.name), p.line2 ? el('small', null, p.line2) : null);
            b.addEventListener('click', () => choose(p));
            return b;
          }),
        );
      }
    });
    queueMicrotask(() => input.focus());
    return form;
  };

  function render() {
    const l = controller.location.get();
    const s = settings.get();
    if (pickerEl) {
      if (pickerEl.parentElement?.parentElement !== root) root.replaceChildren(el('div', { class: 'loc-recovery' }, pickerEl));
      root.hidden = false;
      return;
    }
    if (l.location) {
      // A picked place is named, with a way to change it; GPS needs no line here.
      if (s.locationMode === 'manual' && s.manualPlace) {
        const change = el('button', { class: 'btn small text', type: 'button', 'data-testid': 'place-change' }, 'change');
        change.addEventListener('click', () => {
          pickerEl = picker();
          render();
        });
        root.replaceChildren(el('div', { class: 'place-line', 'data-testid': 'species-place' }, `📍 ${s.manualPlace} · `, change));
        root.hidden = false;
      } else {
        root.replaceChildren();
        root.hidden = true;
      }
      return;
    }
    if (l.status === 'locating' || (l.status === 'idle' && s.locationMode === 'auto')) {
      root.replaceChildren(el('p', { class: 'small muted', style: 'margin:0' }, RECOVERY_TEXT.finding));
      root.hidden = false;
      return;
    }
    const blocked = l.status === 'denied';
    const useBtn = el('button', { class: 'btn primary small', type: 'button', 'data-testid': 'use-my-location' }, blocked ? 'Try again' : 'Use my location');
    useBtn.addEventListener('click', usePosition);
    const pickBtn = el('button', { class: 'btn small', type: 'button', 'data-testid': 'pick-a-place' }, 'Pick a place');
    pickBtn.addEventListener('click', () => {
      pickerEl = picker();
      render();
    });
    root.replaceChildren(
      el(
        'div',
        { class: 'loc-recovery', 'data-kind': blocked ? 'blocked' : 'world' },
        el('strong', null, blocked ? RECOVERY_TEXT.blockedTitle : RECOVERY_TEXT.worldTitle),
        ...(blocked ? [el('p', null, RECOVERY_TEXT.blockedSafari), el('p', null, RECOVERY_TEXT.blockedChrome)] : [el('p', null, RECOVERY_TEXT.worldBody)]),
        el('div', { class: 'row' }, useBtn, pickBtn),
      ),
    );
    root.hidden = false;
  }

  const unsub = controller.location.on('change', render);
  render();
  return { el: root, render, dispose: unsub };
}
