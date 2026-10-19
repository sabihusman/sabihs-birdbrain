import type { Species } from '../../model/labels';
import { getClip, listSightingsForSpecies } from '../../storage/db';
import type { ClipRecord, SightingRecord } from '../../storage/types';
import type { ViewContext } from '../app';
import { el, fmtDateTime, pct } from '../dom';
import { hrefFor } from '../router';
import { speciesColor } from '../../species/colors';
import { clipCard } from './clip-card';
import { locationBlock } from './location-block';
import { mapPreview } from './map-preview';
import { memberGate } from './member-gate';

/**
 * Member-only species ID card: most recent sighting location (map preview,
 * coordinates, Google Maps link, Plus Code under "More location details",
 * the same block as the sighting card) and the species' saved ID clip
 * (player, spectrogram with the identifying windows outlined, tap-to-run
 * "Why this ID"). Tapping the card opens the sighting history. Everything is
 * read from IndexedDB; nothing is fetched except OSM tiles for the map preview.
 */
export function speciesIdCard(ctx: ViewContext, species: Species): { el: HTMLElement; dispose: () => void } {
  const { controller, api } = ctx;
  return memberGate(
    api,
    'the species ID card',
    () => {
      const disposers: Array<() => void> = [];
      const historyHref = hrefFor({ name: 'species-history', scientific: species.scientific });
      const body = el('div', { class: 'stack' }, el('p', { class: 'muted' }, 'Loading…'));
      const card = el(
        'section',
        { class: 'card id-card', 'data-testid': 'species-id-card', role: 'link', tabindex: '0', 'aria-label': `${species.common}: open sighting history` },
        el('div', { class: 'row between' }, el('h2', { style: 'margin:0' }, 'Species ID card'), el('a', { class: 'small', href: historyHref, 'data-testid': 'history-link' }, 'Sighting history ›')),
        body,
      );
      const open = () => {
        location.hash = historyHref;
      };
      card.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t.closest('button, a, audio, input, select, canvas, .viz, .leaflet-container')) return;
        open();
      });
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === card) open();
      });

      const render = async () => {
        let dets: SightingRecord[];
        let clip: ClipRecord | undefined;
        try {
          [dets, clip] = await Promise.all([listSightingsForSpecies(species.scientific), getClip(species.scientific)]);
        } catch {
          body.replaceChildren(el('p', { class: 'muted' }, 'Could not read your data.'));
          return;
        }
        for (const d of disposers.splice(0)) d();
        const located = dets.filter((d) => d.lat != null && d.lon != null);
        const latest = located[located.length - 1];
        const parts: HTMLElement[] = [];
        if (latest) {
          const preview = mapPreview(latest.lat!, latest.lon!, { color: speciesColor(species.scientific).css, label: species.common });
          disposers.push(preview.dispose);
          parts.push(el('div', { class: 'stack' }, el('div', { class: 'small muted' }, `Most recent sighting · ${fmtDateTime(latest.lastTime)} · peak ${pct(latest.peakConfidence)} · ${latest.hits} window${latest.hits === 1 ? '' : 's'}`), preview.el, locationBlock(latest.lat!, latest.lon!, { accuracy: latest.accuracy })));
        } else {
          parts.push(el('p', { class: 'small muted' }, dets.length ? `${dets.length} sighting${dets.length === 1 ? '' : 's'}, none with a position yet.` : 'No sightings of this species yet.'));
        }
        if (clip) {
          const block = clipCard(ctx, species, clip);
          disposers.push(block.dispose);
          parts.push(block.el);
        } else {
          parts.push(el('p', { class: 'small muted' }, 'No saved clip yet. One raw clip of up to 10 seconds around the detection is kept per species, replaced only by a more confident detection.'));
        }
        parts.push(el('div', { class: 'small muted' }, 'Tap the card for the full sighting history and map. Kept on this device only.'));
        body.replaceChildren(...parts);
      };
      void render();
      const unsubs = [controller.on('detections-changed', () => void render()), controller.on('clip-saved', (c) => (c.scientific === species.scientific ? void render() : undefined))];
      return {
        el: card,
        dispose() {
          for (const u of unsubs) u();
          for (const d of disposers) d();
        },
      };
    },
    { testId: 'species-id-card-gate' },
  );
}
