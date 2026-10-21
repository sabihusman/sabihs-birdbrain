import type { Species } from '../../model/labels';
import { getSpeciesSummary } from '../../species/wiki';
import { el } from '../dom';

/** Sage tile with a bird outline, shown until a Wikipedia thumbnail is available (or when there is none). */
export function birdPlaceholder(cls = 'result-thumb'): HTMLElement {
  const box = el('span', { class: `${cls} placeholder`, 'aria-hidden': 'true' });
  box.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20c2-8 8-13 16-14-1 8-6 14-14 14H4zM4 20l6-6"/></svg>';
  return box;
}

const thumbCache = new Map<string, Promise<string | null>>();
/** Thumbnail URL from the cached Wikipedia summary; fetched once per species per session, never blocks the card. */
export function speciesThumbnail(species: Species): Promise<string | null> {
  let p = thumbCache.get(species.scientific);
  if (!p) {
    p = queued(() => getSpeciesSummary(species))
      .then((r) => (r.status === 'ok' && r.thumbnail ? r.thumbnail.source : null))
      .catch(() => null);
    thumbCache.set(species.scientific, p);
  }
  return p;
}

/**
 * At most a few Wikipedia lookups at once, so scrolling a long species list
 * does not fire dozens of requests together (Wikipedia rate-limits bursts).
 * Summaries are cached in IndexedDB, so each species is fetched once.
 */
export const MAX_THUMB_LOOKUPS = 3;
let running = 0;
const waiting: Array<() => void> = [];
function queued<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      task()
        .then(resolve, reject)
        .finally(() => {
          running--;
          waiting.shift()?.();
        });
    };
    if (running < MAX_THUMB_LOOKUPS) start();
    else waiting.push(start);
  });
}

let observer: IntersectionObserver | null = null;
const pending = new WeakMap<Element, () => void>();
/** Run `load` once the element scrolls near the viewport (immediately where IntersectionObserver is missing). */
function whenVisible(node: Element, load: () => void): void {
  if (typeof IntersectionObserver === 'undefined') {
    load();
    return;
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer?.unobserve(e.target);
        pending.get(e.target)?.();
        pending.delete(e.target);
      }
    },
    { rootMargin: '200px' },
  );
  pending.set(node, load);
  observer.observe(node);
}

/**
 * Small bird photo for list rows: a placeholder at once, replaced by the
 * Wikipedia thumbnail when the row comes into view. Decorative (the name is
 * always written next to it), so the image has an empty alt.
 */
export function birdThumb(species: Species, cls = 'chip-thumb'): HTMLElement {
  const box = birdPlaceholder(cls);
  whenVisible(box, () => {
    void speciesThumbnail(species).then((src) => {
      if (!src || !box.isConnected) return;
      const img = el('img', { class: cls, src, alt: '', loading: 'lazy', decoding: 'async' }) as HTMLImageElement;
      img.addEventListener('error', () => img.replaceWith(birdPlaceholder(cls)));
      box.replaceWith(img);
    });
  });
  return box;
}
