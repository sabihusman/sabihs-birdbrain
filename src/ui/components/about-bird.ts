import type { Species } from '../../model/labels';
import { getSpeciesSummary, type WikiResult } from '../../species/wiki';
import { getSpeciesSections, SECTION_LABELS, type WikiSectionsResult } from '../../species/wiki-sections';
import { el } from '../dom';

/**
 * "About this bird": the Wikipedia summary (text, thumbnail with Commons
 * attribution, link to the article) plus short collapsed sections from the
 * full article (Description, Song and calls, Habitat, Diet). Both come from
 * en.wikipedia.org and are cached in IndexedDB, so a species seen once works
 * offline. Used by the sighting card and the species page.
 */
export function aboutBird(species: Species): { el: HTMLElement; dispose: () => void } {
  const summaryBox = el('div', { 'data-testid': 'wiki' }, el('p', { class: 'muted' }, 'Loading Wikipedia summary…'));
  const sectionsBox = el('div', { class: 'wiki-sections', 'data-testid': 'wiki-sections' }, el('p', { class: 'small muted' }, 'Loading article sections…'));
  const root = el('section', { class: 'card', 'data-testid': 'about-bird' }, el('h2', null, 'About this bird'), summaryBox, sectionsBox);
  let alive = true;

  const renderSummary = async (force = false) => {
    let result: WikiResult;
    try {
      result = await getSpeciesSummary(species, { force });
    } catch (e) {
      result = { status: 'error', message: (e as Error).message };
    }
    if (!alive) return;
    const retry = el('button', { class: 'btn small', type: 'button' }, 'Retry');
    retry.addEventListener('click', () => void renderSummary(true));
    switch (result.status) {
      case 'ok': {
        const img = result.thumbnail ? el('img', { class: 'wiki-thumb', src: result.thumbnail.source, alt: `${result.title} (Wikipedia image)`, loading: 'lazy' }) : null;
        const attribution = result.image
          ? el('p', { class: 'small muted' }, 'Image: ', result.image.artist ? `${result.image.artist}, ` : '', result.image.license ? (result.image.licenseUrl ? el('a', { href: result.image.licenseUrl, target: '_blank', rel: 'noopener' }, result.image.license) : result.image.license) : 'see licence on Commons', ' · ', el('a', { href: result.image.filePageUrl, target: '_blank', rel: 'noopener' }, 'image file page'))
          : null;
        summaryBox.replaceChildren(el('div', null,
          el('h3', { style: 'margin:0' }, result.displayTitle || result.title),
          result.description ? el('p', { class: 'muted', style: 'margin-top:0' }, result.description) : null,
          img,
          attribution,
          el('p', null, result.extract),
          el('p', { class: 'small' }, el('a', { href: result.pageUrl, target: '_blank', rel: 'noopener' }, 'Read the full Wikipedia article'), ' · looked up by ', result.lookedUpBy, ' name · text CC BY-SA 4.0 · cached ', new Date(result.fetchedAt).toLocaleDateString()),
        ));
        break;
      }
      case 'disambiguation':
        summaryBox.replaceChildren(el('p', null, 'Wikipedia has several pages with this name.'), el('p', null, el('a', { href: result.pageUrl, target: '_blank', rel: 'noopener' }, 'Open the disambiguation page'), ' · ', el('a', { href: result.searchUrl, target: '_blank', rel: 'noopener' }, 'Search Wikipedia')));
        break;
      case 'not-found':
        summaryBox.replaceChildren(el('p', null, 'No Wikipedia page found.'), el('p', null, el('a', { href: result.searchUrl, target: '_blank', rel: 'noopener' }, 'Search Wikipedia')));
        break;
      case 'offline':
        summaryBox.replaceChildren(el('p', null, 'Offline, and this page isn’t saved yet.'), retry);
        break;
      case 'error':
        summaryBox.replaceChildren(el('p', null, `Wikipedia request failed: ${result.message}`), retry);
        break;
    }
  };

  const renderSections = async (force = false) => {
    let result: WikiSectionsResult;
    try {
      result = await getSpeciesSections(species, { force });
    } catch (e) {
      result = { status: 'error', message: (e as Error).message };
    }
    if (!alive) return;
    const retry = el('button', { class: 'btn small', type: 'button' }, 'Retry');
    retry.addEventListener('click', () => void renderSections(true));
    switch (result.status) {
      case 'ok': {
        if (result.sections.length === 0) {
          sectionsBox.replaceChildren(el('p', { class: 'small muted' }, 'No Description, Song, Habitat or Diet section on Wikipedia.'));
          break;
        }
        sectionsBox.replaceChildren(
          ...result.sections.map((s) =>
            el(
              'details',
              { class: 'section-fold', 'data-testid': `wiki-section-${s.kind}` },
              el('summary', null, SECTION_LABELS[s.kind]),
              ...s.text.split(/\n{2,}/).map((para) => el('p', null, para)),
              el('p', { class: 'small' }, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.truncated ? `Full “${s.heading}” section on Wikipedia` : `“${s.heading}” on Wikipedia`)),
            ),
          ),
          el('p', { class: 'small muted', style: 'margin-bottom:0' }, 'Wikipedia excerpts, saved on this phone · CC BY-SA 4.0'),
        );
        break;
      }
      case 'not-found':
        sectionsBox.replaceChildren(el('p', { class: 'small muted' }, 'No article sections found.'));
        break;
      case 'offline':
        sectionsBox.replaceChildren(el('p', { class: 'small muted' }, 'Sections load when you’re back online.'), retry);
        break;
      case 'error':
        sectionsBox.replaceChildren(el('p', { class: 'small muted' }, `Could not load the article sections: ${result.message}`), retry);
        break;
    }
  };

  void renderSummary();
  void renderSections();
  return {
    el: root,
    dispose() {
      alive = false;
    },
  };
}
