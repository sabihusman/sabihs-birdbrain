import { registerSW } from 'virtual:pwa-register';
import type { Notice } from './app/controller';

/** Register the service worker (app shell + model cache). */
export function registerPwa(notify: (n: Notice) => void): void {
  if (!('serviceWorker' in navigator)) return;
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      notify({ kind: 'info', text: 'A new version is available. Reload to update.' });
      // Apply on the next navigation; the notice tells the user.
      setTimeout(() => void update(false), 0);
    },
    onOfflineReady() {
      notify({ kind: 'info', text: 'Ready to work offline.' });
    },
  });
}
