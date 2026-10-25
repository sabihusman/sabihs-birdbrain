import { registerSW } from 'virtual:pwa-register';

export interface PwaHooks {
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
    // No "Ready to work offline." notice (DECISIONS.md #94): on a first visit it appeared before the 78 MB
    // bird model was on the phone, so it promised more than it meant. The status pill says when the model is ready.
  });
}
