import { defineConfig } from 'vite';
import process from 'node:process';
import { VitePWA } from 'vite-plugin-pwa';
import { serveModels } from './scripts/serve-models.mts';
import { DEFAULT_MODEL_BASE_URL, MODEL_VERSION } from './src/model/model-source';

/** '/' on Vercel; set VITE_BASE_PATH to serve the app under a sub-path elsewhere. */
const BASE = (process.env.VITE_BASE_PATH ?? '/').replace(/\/?$/, '/');

/**
 * Where this build will fetch the BirdNET weights (DECISIONS.md #56). The app resolves
 * the same value at run time; the service worker needs it here, because a Workbox
 * regular expression only matches a cross-origin request when it matches from the
 * start of the whole URL.
 */
const MODEL_BASE_URL = (process.env.VITE_MODEL_BASE_URL?.trim() || DEFAULT_MODEL_BASE_URL).replace(/\/*$/, '/');
// Only "." needs escaping in a URL made of letters, digits, ":", "/" and "." .
const CROSS_ORIGIN_MODELS = /^https?:\/\//.test(MODEL_BASE_URL) ? [new RegExp('^' + MODEL_BASE_URL.split('.').join('\\.') + '.*\\.(bin|json)$')] : [];

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
    // Dev and preview only: serves the repository's models/ folder, which production
    // gets from the API host.
    serveModels(BASE),
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
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,wasm}', `models/${MODEL_VERSION}/labels.json`],
        // The weights are not in dist/ any more (they come from the API host); samples and
        // any stray model file are cached at runtime instead of being precached.
        globIgnores: ['**/node_modules/**', 'models/**/*.bin', 'models/**/model.json', 'samples/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        runtimeCaching: [
          // BirdNET topology and weight shards, cache-first so a second run is offline.
          // Two routes: the absolute URL of the model host for a production build, and the
          // same-origin path used by dev, preview and the Playwright suite.
          ...[...CROSS_ORIGIN_MODELS, /\/models\/birdnet-v2\.4\/.*\.(bin|json)$/].map((urlPattern) => ({
            urlPattern,
            handler: 'CacheFirst' as const,
            options: {
              cacheName: 'birdnet-models-v2.4',
              // 23 model files plus room for a second version during a changeover.
              expiration: { maxEntries: 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          })),
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
