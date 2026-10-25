import { createPreviewMap, type PreviewMap } from '../views/map';
import { el } from '../dom';

export interface MapPreview {
  el: HTMLElement;
  /** Recolour the dot (the sighting card learns its species after analysis). */
  setColor(css: string): void;
  dispose(): void;
}

/**
 * ~160 px map preview with one dot at the spot, non-interactive until the
 * "Tap to explore" cover is tapped. Tiles need the network: offline, a muted
 * placeholder stands in and the map is built once the browser comes back
 * online. The OSM attribution control stays on the map.
 */
export function mapPreview(lat: number, lon: number, opts: { color: string; label: string }): MapPreview {
  const root = el('div', { class: 'map-preview', 'data-testid': 'map-preview' });
  let map: PreviewMap | null = null;
  let color = opts.color;
  let disposed = false;
  let tries = 0;

  const build = () => {
    if (disposed || map || !root.isConnected) {
      // Leaflet needs the container in the DOM with a size; try again on the next frames.
      if (!disposed && !map && tries++ < 20) requestAnimationFrame(build);
      return;
    }
    root.replaceChildren();
    const box = el('div', { class: 'map-preview-map', role: 'img', 'aria-label': `Map around ${opts.label}` });
    const cover = el('button', { class: 'map-preview-cover', type: 'button', 'aria-label': `Tap to explore the map around ${opts.label}` }, el('span', null, 'Tap to explore'));
    cover.addEventListener('click', () => {
      cover.remove();
      map?.enable();
    });
    root.append(box, cover);
    map = createPreviewMap(box, lat, lon, color);
  };

  const showPlaceholder = () => {
    root.replaceChildren(el('div', { class: 'map-placeholder', 'data-testid': 'map-placeholder' }, 'Map needs a connection; the details below work offline.'));
  };

  const onOnline = () => {
    if (!map) requestAnimationFrame(build);
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    showPlaceholder();
    window.addEventListener('online', onOnline);
  } else {
    requestAnimationFrame(build);
  }

  return {
    el: root,
    setColor(css) {
      color = css;
      map?.setColor(css);
    },
    dispose() {
      disposed = true;
      window.removeEventListener('online', onOnline);
      map?.dispose();
      map = null;
    },
  };
}
