import { searchSpecies, type Species } from '../../model/labels';
import { speciesColor } from '../../species/colors';
import { getSpeciesSummary, type WikiResult } from '../../species/wiki';
import { listSightingsForSpecies, getRecording } from '../../storage/db';
import type { SightingRecord } from '../../storage/types';
import type { View, ViewContext } from '../app';
import { speciesChip } from '../components/species-chip';
import { el, fmtDateTime, pct } from '../dom';
import { hrefFor } from '../router';
import { createMiniMap } from './map';
import { askBox } from '../components/ask-box';
import { locationBlock } from '../components/location-block';
import { speciesIdCard } from '../components/species-id-card';
import { isMember } from '../../app/access';
import { describeLocalCount, filterLocal } from '../../species/local';

const PAGE = 60;

export function speciesListView(ctx: ViewContext): View {
  const { controller } = ctx;
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
  let shown = 0;
  let results: Species[] = [];

  const render = (reset: boolean) => {
    if (reset) {
      list.replaceChildren();
      shown = 0;
    }
    const next = results.slice(shown, shown + PAGE);
    for (const sp of next) list.appendChild(speciesChip(sp));
    shown += next.length;
    more.style.display = shown < results.length ? '' : 'none';
    count.textContent = results.length ? `${results.length.toLocaleString()} species${shown < results.length ? `, showing ${shown}` : ''}` : controller.species.length ? 'No matches.' : 'Loading species list…';
  };
  const search = () => {
    const all = controller.species.filter((s) => s.isBird || settings.get().includeNonBird);
    const local = controller.getLocalSpecies();
    const scope = filterLocal(all, local.indices, settings.get().speciesShowAll, local.note);
    localLine.textContent = all.length ? describeLocalCount(scope) : '';
    note.textContent = scope.note ?? '';
    note.style.display = scope.note ? '' : 'none';
    showAll.disabled = local.indices === null;
    results = input.value.trim() ? searchSpecies(scope.shown, input.value, 500) : scope.shown;
    render(true);
  };
  input.addEventListener('input', search);
  more.addEventListener('click', () => render(false));
  const unsubs = [controller.on('species-loaded', search), controller.on('local-species', search)];
  search();

  const root = el('div', null, el('section', { class: 'card' }, input, localLine, note, toggle, el('p', { class: 'small muted' }, 'Works offline: the list is bundled with the app and the local list is computed on this device. Wikipedia pages are cached after the first visit. Identification on Listen is not affected by this list.'), count), list, el('div', { class: 'center', style: 'margin-top:12px' }, more));
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
    const wikiBox = el('div', { 'data-testid': 'wiki' }, el('p', { class: 'muted' }, 'Loading Wikipedia summary…'));
    const ask = askBox(ctx.api, sp);
    disposers.push(ask.dispose);
    const idCard = speciesIdCard(ctx, sp);
    disposers.push(idCard.dispose);
    const myBox = el('div', null, el('p', { class: 'muted' }, 'Loading your detections…'));
    root.replaceChildren(
      el('section', { class: 'card' }, el('div', { class: 'row' }, el('span', { class: 'swatch', style: `background:${color.css};width:22px;height:22px`, 'aria-hidden': 'true' }), el('div', null, el('h2', { style: 'margin:0' }, sp.common), el('div', { class: 'muted', style: 'font-style:italic' }, sp.scientific))), el('p', { class: 'small muted' }, 'Colour used for this species everywhere in the app.')),
      idCard.el,
      el('section', { class: 'card' }, wikiBox),
      ask.el,
      el('section', { class: 'card' }, el('h2', null, 'Your sightings'), myBox),
    );
    void renderWiki(sp, wikiBox);
    void renderMine(sp, myBox);
  };

  const renderWiki = async (sp: Species, box: HTMLElement, force = false) => {
    let result: WikiResult;
    try {
      result = await getSpeciesSummary(sp, { force });
    } catch (e) {
      result = { status: 'error', message: (e as Error).message };
    }
    const retry = el('button', { class: 'btn small' }, 'Retry');
    retry.addEventListener('click', () => void renderWiki(sp, box, true));
    switch (result.status) {
      case 'ok': {
        const img = result.thumbnail
          ? el('img', { class: 'wiki-thumb', src: result.thumbnail.source, alt: `${result.title} (Wikipedia image)`, loading: 'lazy' })
          : null;
        const attribution = result.image
          ? el('p', { class: 'small muted' }, 'Image: ', result.image.artist ? `${result.image.artist}, ` : '', result.image.license ? (result.image.licenseUrl ? el('a', { href: result.image.licenseUrl, target: '_blank', rel: 'noopener' }, result.image.license) : result.image.license) : 'see licence on Commons', ' · ', el('a', { href: result.image.filePageUrl, target: '_blank', rel: 'noopener' }, 'image file page'))
          : null;
        box.replaceChildren(el('div', null,
          el('h2', null, result.displayTitle || result.title),
          result.description ? el('p', { class: 'muted' }, result.description) : null,
          img,
          attribution,
          el('p', null, result.extract),
          el('p', { class: 'small' }, el('a', { href: result.pageUrl, target: '_blank', rel: 'noopener' }, 'Read the full Wikipedia article'), ' · looked up by ', result.lookedUpBy, ' name · text CC BY-SA 4.0 · cached ', new Date(result.fetchedAt).toLocaleDateString()),
        ));
        break;
      }
      case 'disambiguation':
        box.replaceChildren(el('p', null, 'Wikipedia has several pages with this name.'), el('p', null, el('a', { href: result.pageUrl, target: '_blank', rel: 'noopener' }, 'Open the disambiguation page'), ' · ', el('a', { href: result.searchUrl, target: '_blank', rel: 'noopener' }, 'Search Wikipedia')));
        break;
      case 'not-found':
        box.replaceChildren(el('p', null, 'No Wikipedia summary found for this species under either name.'), el('p', null, el('a', { href: result.searchUrl, target: '_blank', rel: 'noopener' }, 'Search Wikipedia')));
        break;
      case 'offline':
        box.replaceChildren(el('p', null, 'You are offline and this species has not been viewed before, so there is no cached summary.'), retry);
        break;
      case 'error':
        box.replaceChildren(el('p', null, `Wikipedia request failed: ${result.message}`), retry);
        break;
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
  return {
    el: root,
    dispose() {
      for (const d of disposers) d();
    },
  };
}

export { speciesChip };
