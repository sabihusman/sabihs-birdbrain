import type { Species } from '../../model/labels';
import { fmtDay, type SpottedBy } from '../../species/friends';
import { localDay } from '../../species/sharing';
import { listSightingsForSpecies } from '../../storage/db';
import type { ViewContext } from '../app';
import { el } from '../dom';

/**
 * "Spotted by" on a species page (members): one row per person, me included
 * as "You", each with only the day of their most recent sighting, newest
 * first. My row opens the species ID card; friends' rows are not tappable.
 * Friends' days come from the FriendsCache, mine from IndexedDB.
 */
export function spottedByBlock(ctx: ViewContext, species: Species, findIdCard: () => HTMLElement | null): { el: HTMLElement; dispose: () => void } {
  const { controller, friends } = ctx;
  const list = el('div', { class: 'stack', 'data-testid': 'spotted-by-list' }, el('p', { class: 'muted' }, 'Loading…'));
  const root = el('section', { class: 'card', 'data-testid': 'spotted-by' }, el('h2', null, 'Spotted by'), list, el('p', { class: 'small muted' }, 'Each person appears once with the day they last spotted this bird. Friends share only the bird and that day.'));

  const render = async () => {
    let mine: string | null = null;
    try {
      const dets = await listSightingsForSpecies(species.scientific);
      if (dets.length) mine = localDay(Math.max(...dets.map((d) => d.lastTime)));
    } catch {
      mine = null;
    }
    const rows: Array<SpottedBy & { me: boolean }> = friends.spottedBy(species.scientific).map((r) => ({ ...r, me: false }));
    if (mine) rows.push({ name: 'You', lastSeen: mine, me: true });
    rows.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : a.me ? -1 : b.me ? 1 : a.name.localeCompare(b.name)));
    list.replaceChildren();
    if (rows.length === 0) {
      list.append(el('p', { class: 'muted' }, 'Not spotted by you or your friends yet.'));
      return;
    }
    for (const r of rows) {
      const text = `${r.name} · ${fmtDay(r.lastSeen)}`;
      if (r.me) {
        const btn = el('button', { class: 'spotted-by-row me', type: 'button', 'data-testid': 'spotted-by-me', 'aria-label': `You, ${fmtDay(r.lastSeen)}. Open your species ID card.` }, el('span', null, text), el('span', { class: 'muted', 'aria-hidden': 'true' }, 'ID card ›'));
        btn.addEventListener('click', () => {
          const card = findIdCard();
          card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          card?.focus({ preventScroll: true });
        });
        list.append(btn);
      } else {
        list.append(el('div', { class: 'spotted-by-row', 'data-testid': 'spotted-by-friend' }, text));
      }
    }
  };

  void render();
  const unsubs = [friends.on('change', () => void render()), controller.on('detections-changed', () => void render())];
  return {
    el: root,
    dispose() {
      for (const u of unsubs) u();
    },
  };
}
