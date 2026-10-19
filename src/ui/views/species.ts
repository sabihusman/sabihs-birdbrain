import { searchSpecies, type Species } from '../../model/labels';
import { speciesColor } from '../../species/colors';
import { listSightingsForSpecies, getRecording } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import type { View, ViewContext } from '../app';
import { speciesChip } from '../components/species-chip';
import { el, fmtDateTime, pct } from '../dom';
import { hrefFor, speciesHref } from '../router';
import { createMiniMap } from './map';
import { aboutBird } from '../components/about-bird';
import { askBox } from '../components/ask-box';
import { locationBlock } from '../components/location-block';
import { speciesIdCard } from '../components/species-id-card';
import { lockedNoteEl } from '../components/member-gate';
import { isMember, memberAccess } from '../../app/access';
import { isSpotted, loadSpottedSet, type SpottedSet } from '../../species/spotted';
import { scopeSpeciesList } from '../../species/list-scope';
import { describeSpottedBy } from '../../species/friends';
import { spottedByBlock } from '../components/spotted-by';

const PAGE = 60;

/** Set by the tick on the Species tab so the detail view lands on the ID card (members only). */
let focusIdCardOnOpen = false;

export function speciesListView(ctx: ViewContext): View {
  const { controller, api } = ctx;
  const settings = controller.settings;
  const input = el('input', { class: 'search', type: 'search', placeholder: 'Search species by common or scientific name', 'aria-label': 'Search species', autocomplete: 'off' });
  const list = el('div', { class: 'chip-list', 'data-testid': 'species-list' });
  const more = el('button', { class: 'btn small' }, 'Show more');
  const count = el('div', { class: 'small muted' }, '');
  const localLine = el('div', { class: 'small', 'data-testid': 'local-count' }, '');
  const note = el('div', { class: 'small muted', 'data-testid': 'local-note' }, '');
  const showAll = el('input', { type: 'checkbox', checked: settings.get().speciesShowAll, 'data-testid': 'show-all-species' });
  showAll.addEventListener('change', () => {
    settings.update({ speciesShowAll: showAll.checked });
    search();
  });
  const toggle = el('label', { class: 'switch' }, el('span', null, 'Show all species', el('div', { class: 'small muted' }, 'Off: only species the location model expects near you in some week of the year.')), showAll);
  // "Spotted by me": species with at least one sighting on this device (DECISIONS.md #41).
  const spottedCount = el('span', { class: 'filter-chip-count' }, '');
  const spottedChip = el('button', { class: 'filter-chip', type: 'button', 'aria-pressed': String(settings.get().speciesSpottedOnly), 'data-testid': 'spotted-filter' }, el('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'), 'Spotted by me', spottedCount);
  spottedChip.addEventListener('click', () => {
    const on = !settings.get().speciesSpottedOnly;
    settings.update({ speciesSpottedOnly: on });
    spottedChip.setAttribute('aria-pressed', String(on));
    search();
  });
  // "Spotted by friends": species any accepted friend has shared (DECISIONS.md #44). Members only; the chip hides otherwise.
  let friendsOnly = false;
  const friendsCount = el('span', { class: 'filter-chip-count' }, '');
  const friendsChip = el('button', { class: 'filter-chip', type: 'button', 'aria-pressed': 'false', 'data-testid': 'friends-filter' }, el('span', { class: 'tick', 'aria-hidden': 'true' }, '👥'), 'Spotted by friends', friendsCount);
  friendsChip.addEventListener('click', () => {
    friendsOnly = !friendsOnly;
    friendsChip.setAttribute('aria-pressed', String(friendsOnly));
    search();
  });
  let spotted: SpottedSet = new Set();
  let shown = 0;
  let results: Species[] = [];

  /** One list row: the species chip (with "Spotted by Alex, Sam" when friends shared it) plus, when spotted by me, a tick that opens the ID card (members) or says "Sign in to unlock". */
  const row = (sp: Species): HTMLElement => {
    const by = ctx.friends.spottedBy(sp.scientific);
    const chip = speciesChip(sp, by.length ? { subtitle: describeSpottedBy(by) } : {});
    if (by.length) chip.dataset.spottedByFriends = 'true';
    if (!isSpotted(sp, spotted)) return chip;
    const tick = el('button', { class: 'tick-btn', type: 'button', 'data-testid': 'spotted-tick', title: 'Spotted by you', 'aria-label': `${sp.common}: spotted by you. Open the species ID card.` }, el('span', { 'aria-hidden': 'true' }, '✓'));
    const wrap = el('div', { class: 'spotted-row', 'data-testid': 'spotted-row' }, el('div', { class: 'row' }, chip, tick));
    tick.addEventListener('click', () => {
      const access = memberAccess(api.user);
      if (access === 'member') {
        focusIdCardOnOpen = true;
        location.hash = speciesHref(sp.scientific);
        return;
      }
      const old = wrap.querySelector('.locked-note');
      if (old) old.remove();
      else wrap.appendChild(lockedNoteEl(access, 'the species ID card'));
    });
    return wrap;
  };

  const render = (reset: boolean) => {
    if (reset) {
      list.replaceChildren();
      shown = 0;
    }
    const next = results.slice(shown, shown + PAGE);
    for (const sp of next) list.appendChild(row(sp));
    shown += next.length;
    more.style.display = shown < results.length ? '' : 'none';
    count.textContent = results.length ? `${results.length.toLocaleString()} species${shown < results.length ? `, showing ${shown}` : ''}` : controller.species.length ? 'No matches.' : 'Loading species list…';
  };
  const search = () => {
    const all = controller.species.filter((s) => s.isBird || settings.get().includeNonBird);
    const local = controller.getLocalSpecies();
    const scope = scopeSpeciesList({
      all,
      localIndices: local.indices,
      localNote: local.note,
      showAll: settings.get().speciesShowAll,
      spotted,
      spottedOnly: settings.get().speciesSpottedOnly,
      friendSpecies: ctx.friends.species(),
      friendsAvailable: ctx.friends.available,
      friendsOnly,
      friendCount: ctx.friends.friendCount,
    });
    friendsOnly = scope.friendsOnly;
    friendsChip.style.display = ctx.friends.available ? '' : 'none';
    friendsChip.setAttribute('aria-pressed', String(friendsOnly));
    friendsCount.textContent = scope.friendsCount;
    spottedCount.textContent = scope.spottedCount;
    localLine.textContent = scope.line;
    note.textContent = scope.note ?? '';
    note.style.display = scope.note ? '' : 'none';
    showAll.disabled = local.indices === null;
    results = input.value.trim() ? searchSpecies(scope.shown, input.value, 500) : scope.shown;
    render(true);
  };
  const refreshSpotted = () => {
    loadSpottedSet().then(
      (set) => {
        spotted = set;
        search();
      },
      () => undefined, // storage unavailable: no ticks, the list still works
    );
  };
  input.addEventListener('input', search);
  more.addEventListener('click', () => render(false));
  const unsubs = [controller.on('species-loaded', search), controller.on('local-species', search), controller.on('detections-changed', refreshSpotted), api.on('change', search), ctx.friends.on('change', search)];
  search();
  refreshSpotted();
  void ctx.friends.refresh(); // when online and a member; the cached copy shows meanwhile

  const root = el('div', null, el('section', { class: 'card' }, input, el('div', { class: 'chip-row' }, spottedChip, friendsChip), localLine, note, toggle, el('p', { class: 'small muted' }, 'Works offline: the list is bundled with the app and the local list is computed on this device. Wikipedia pages are cached after the first visit. Identification on Listen is not affected by this list. A tick marks a species you have a sighting of; it stays on this device.'), count), list, el('div', { class: 'center', style: 'margin-top:12px' }, more));
  return {
    el: root,
    dispose() {
      for (const u of unsubs) u();
    },
  };
}

export function speciesDetailView(ctx: ViewContext, scientific: string): View {
  const { controller } = ctx;
  const root = el('div', null);
  const disposers: Array<() => void> = [];

  const build = () => {
    const sp = controller.speciesByScientific(scientific);
    if (!sp) {
      root.replaceChildren(el('section', { class: 'card' }, controller.species.length ? `Unknown species “${scientific}”.` : 'Loading species list…'));
      return;
    }
    const color = speciesColor(sp.scientific);
    const about = aboutBird(sp);
    disposers.push(about.dispose);
    const ask = askBox(ctx.api, sp);
    disposers.push(ask.dispose);
    const idCard = speciesIdCard(ctx, sp);
    disposers.push(idCard.dispose);
    const myBox = el('div', null, el('p', { class: 'muted' }, 'Loading your detections…'));
    const spottedBy = ctx.friends.available ? spottedByBlock(ctx, sp, () => idCard.el.querySelector<HTMLElement>('[data-testid="species-id-card"]')) : null;
    if (spottedBy) disposers.push(spottedBy.dispose);
    root.replaceChildren(
      el('section', { class: 'card' }, el('div', { class: 'row' }, el('span', { class: 'swatch', style: `background:${color.css};width:22px;height:22px`, 'aria-hidden': 'true' }), el('div', null, el('h2', { style: 'margin:0' }, sp.common), el('div', { class: 'muted', style: 'font-style:italic' }, sp.scientific))), el('p', { class: 'small muted' }, 'Colour used for this species everywhere in the app.')),
      ...(spottedBy ? [spottedBy.el] : []),
      idCard.el,
      about.el,
      ask.el,
      el('section', { class: 'card' }, el('h2', null, 'Your sightings'), myBox),
    );
    void renderMine(sp, myBox);
    if (focusIdCardOnOpen) {
      focusIdCardOnOpen = false;
      requestAnimationFrame(() => {
        const card = idCard.el.querySelector<HTMLElement>('[data-testid="species-id-card"]');
        card?.scrollIntoView({ block: 'start' });
        card?.focus({ preventScroll: true });
      });
    }
  };

  const renderMine = async (sp: Species, box: HTMLElement) => {
    let dets: SightingRecord[];
    try {
      dets = await listSightingsForSpecies(sp.scientific);
    } catch {
      box.replaceChildren(el('p', { class: 'muted' }, 'Could not read sightings.'));
      return;
    }
    if (dets.length === 0) {
      box.replaceChildren(el('p', { class: 'muted' }, 'You have not detected this species yet.'));
      return;
    }
    const first = dets[0];
    const last = dets[dets.length - 1];
    const best = dets.reduce((a, b) => (b.peakConfidence > a.peakConfidence ? b : a), dets[0]);
    const windows = dets.reduce((n, s) => n + s.hits, 0);
    const located = dets.filter((d) => d.lat != null && d.lon != null);
    const recIds = Array.from(new Set(dets.map((d) => d.recordingId).filter((x): x is string => !!x)));
    const recList = el('div', { class: 'list' });
    for (const id of recIds.slice(0, 20)) {
      const rec = await getRecording(id).catch(() => undefined);
      if (rec) recList.appendChild(el('a', { class: 'list-item', href: hrefFor({ name: 'recording', id }) }, el('div', { class: 'title' }, rec.name), el('div', { class: 'small muted' }, fmtDateTime(rec.createdAt))));
    }
    const mapBox = el('div', { class: 'map mini' });
    // Members get the latest location and map in the ID card above; free users keep them here.
    const showLocation = !isMember(ctx.api.user);
    box.replaceChildren(el('div', null,
      el('dl', { class: 'kv' }, el('dt', null, 'Sightings'), el('dd', null, `${dets.length} (${windows} analysed window${windows === 1 ? '' : 's'})`), el('dt', null, 'First seen'), el('dd', null, fmtDateTime(first.firstTime)), el('dt', null, 'Last seen'), el('dd', null, fmtDateTime(last.lastTime)), el('dt', null, 'Best confidence'), el('dd', null, pct(best.peakConfidence))),
      !showLocation ? null : located.length ? el('div', { class: 'stack' }, el('div', { class: 'small muted' }, 'Latest located sighting'), locationBlock(located[located.length - 1].lat!, located[located.length - 1].lon!, { accuracy: located[located.length - 1].accuracy }), mapBox) : el('p', { class: 'small muted' }, 'No detections with a position yet.'),
      recIds.length ? el('h3', null, 'Recordings') : null,
      recList,
    ));
    if (showLocation && located.length) {
      requestAnimationFrame(() => disposers.push(createMiniMap(mapBox, located, controller)));
    }
  };

  build();
  disposers.push(controller.on('species-loaded', build));
  disposers.push(ctx.api.on('change', build));
  void ctx.friends.refresh();
  return {
    el: root,
    dispose() {
      for (const d of disposers) d();
    },
  };
}

export { speciesChip };
