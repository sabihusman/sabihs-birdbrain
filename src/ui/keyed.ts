/**
 * Keeping list items between renders. Listen re-renders its cards on every analysis window
 * (about every 1.5 s); building them afresh each time reloaded every photo and clip and made the
 * panel flicker. A pool hands back the same card for the same key, and `syncChildren` moves only
 * the nodes that are out of place, so a card that stays keeps its loaded photo.
 */
export interface Disposable {
  el: HTMLElement;
  dispose: () => void;
}

export interface KeyedPool<T extends Disposable> {
  /** The card kept under `key`, or a new one from `create`; marks it as used in this render. */
  take: (key: string, create: () => T) => T;
  /** Removes and disposes every card not taken since the last sweep. */
  sweep: () => void;
  /** Disposes every card (the view is going away). */
  clear: () => void;
  readonly size: number;
}

export function keyedPool<T extends Disposable>(): KeyedPool<T> {
  const items = new Map<string, T>();
  let used = new Set<string>();
  return {
    take(key, create) {
      let item = items.get(key);
      if (!item) {
        item = create();
        items.set(key, item);
      }
      used.add(key);
      return item;
    },
    sweep() {
      for (const [key, item] of items) {
        if (used.has(key)) continue;
        item.el.remove();
        item.dispose();
        items.delete(key);
      }
      used = new Set();
    },
    clear() {
      for (const item of items.values()) item.dispose();
      items.clear();
      used = new Set();
    },
    get size() {
      return items.size;
    },
  };
}

/** Makes `parent`'s children exactly `nodes`, in order, moving only what is out of place. */
export function syncChildren(parent: Element, nodes: readonly Node[]): void {
  nodes.forEach((node, i) => {
    const at = parent.childNodes[i] ?? null;
    if (at !== node) parent.insertBefore(node, at);
  });
  while (parent.childNodes.length > nodes.length) parent.lastChild?.remove();
}
