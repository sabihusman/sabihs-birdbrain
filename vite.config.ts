import { defineConfig } from 'vite';
import process from 'node:process';
import { VitePWA } from 'vite-plugin-pwa';

/** '/' on Vercel; set VITE_BASE_PATH to serve the app under a sub-path elsewhere. */
const BASE = (process.env.VITE_BASE_PATH ?? '/').replace(/\/?$/, '/');

export default defineConfig({
  base: BASE,
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: 'es',
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Sabih’s Birdbrain',
        short_name: 'Birdbrain',
        description: 'On-device bird sound identification with BirdNET. Audio never leaves your phone.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f1a14',
        theme_color: '#0f1a14',
        categories: ['education', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell: code, styles, icons, the AudioWorklet module, WASM backend and the label list
        // (needed for the offline species browser). Model shards are cached at runtime on first
        // load instead of being precached, so the first run does not download them twice.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,wasm}', 'models/birdnet-v2.4/labels.json'],
        globIgnores: ['**/node_modules/**', 'models/**/*.bin', 'models/**/model.json', 'samples/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // BirdNET model topology and weight shards: cache-first, same origin only.
            urlPattern: /\/models\/birdnet-v2\.4\/.*\.(bin|json)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'birdnet-models-v2.4',
              expiration: { maxEntries: 40 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/samples\/.*\.wav$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'birdbrain-samples', expiration: { maxEntries: 4 } },
          },
          // No route for tile.openstreetmap.org: map tiles are never cached by the service worker
          // (OSM tile usage policy).
        ],
      },
    }),
  ],
});
