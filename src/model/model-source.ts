/**
 * Where the BirdNET model files come from (DECISIONS.md #56).
 *
 * The 23 heavy files (~78 MiB) are not part of the deployed front end any more:
 * Nginx serves them from the Birdbrain server at `/models/<version>/`, which keeps
 * Vercel's deployment storage and data transfer small. `labels.json` stays in the
 * app's own `public/` folder, because it is precached for the offline species list.
 *
 * One setting changes the source everywhere: `VITE_MODEL_BASE_URL` (build time).
 * Unset, a development or preview build loads them from its own server (Vite serves
 * the repository's `models/` folder at `<base>models/`), and a production build from
 * the API host. Always ends with a single "/".
 */

/** Model version folder; the files inside a version never change (see the immutable Cache-Control). */
export const MODEL_VERSION = 'birdnet-v2.4';

/** Production source: Nginx on the API host, with CORS for this app's origins only. */
export const DEFAULT_MODEL_BASE_URL = `https://bird-brain.duckdns.org/models/${MODEL_VERSION}/`;

function withTrailingSlash(url: string): string {
  return url.replace(/\/*$/, '/');
}

/**
 * Resolve the model base URL. `env` and `devBase` are parameters so the unit tests can
 * cover every case without a build.
 */
export function resolveModelBaseUrl(env: { VITE_MODEL_BASE_URL?: string; DEV?: boolean; BASE_URL?: string }): string {
  const configured = env.VITE_MODEL_BASE_URL?.trim();
  if (configured) return withTrailingSlash(configured);
  if (env.DEV) return withTrailingSlash(`${env.BASE_URL ?? '/'}models/${MODEL_VERSION}`);
  return DEFAULT_MODEL_BASE_URL;
}

type ViteEnv = { VITE_MODEL_BASE_URL?: string; DEV?: boolean; BASE_URL?: string };

/** `import.meta.env` is undefined when Node imports this file (vite.config.ts does, for the service-worker route). */
export const MODEL_BASE_URL = resolveModelBaseUrl(((import.meta.env ?? {}) as ViteEnv | undefined) ?? {});

/** Plain-language message for a failed model download (DESIGN_GUIDE.md §2: say what to do). */
export const MODEL_DOWNLOAD_ERROR = "Couldn't download the bird model. Check your connection and try again.";
