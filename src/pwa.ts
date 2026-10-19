import { registerSW } from 'virtual:pwa-register';
import type { Notice } from './app/controller';

export interface PwaHooks {
  notify: (n: Notice) => void;
  /** A new version is waiting; call `apply()` to activate it and reload. Never called with a reload while listening: the UI decides when. */
  onUpdateAvailable: (apply: () => Promise<void>) => void;
}

/** Register the service worker (app shell + model cache). Updates are applied only when the user taps the banner. */
export function registerPwa(hooks: PwaHooks): void {
  if (!('serviceWorker' in navigator)) return;
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      hooks.onUpdateAvailable(() => update(true));
    },
    onOfflineReady() {
      hooks.notify({ kind: 'info', text: 'Ready to work offline.' });
    },
  });
}
