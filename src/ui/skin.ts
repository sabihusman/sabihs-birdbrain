import { Emitter } from '../shared/emitter';

/**
 * The app shell's skin (DECISIONS.md #110): BirdAmp dresses the header and the tab bar while it is the Listen
 * layout on the Listen tab, and nowhere else. Listen sets it; leaving Listen (or another layout) clears it.
 */
export type ShellSkin = 'birdamp' | null;

const emitter = new Emitter<{ change: ShellSkin }>();
let current: ShellSkin = null;

export function setShellSkin(skin: ShellSkin): void {
  if (skin === current) return;
  current = skin;
  if (typeof document !== 'undefined') {
    if (skin) document.documentElement.dataset.skin = skin;
    else delete document.documentElement.dataset.skin;
  }
  emitter.emit('change', skin);
}

export function shellSkin(): ShellSkin {
  return current;
}

export function onShellSkin(cb: (skin: ShellSkin) => void): () => void {
  return emitter.on('change', cb);
}
