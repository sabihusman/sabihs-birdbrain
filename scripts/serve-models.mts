/**
 * Vite plugin: serve the repository's `models/` folder during `vite dev` and
 * `vite preview`, at `<base>models/`.
 *
 * In production those files come from the API host (src/model/model-source.ts) and are
 * deliberately not part of `dist/`, so without this plugin a local run or the
 * Playwright suite would have to download 78 MiB from the live server. It sends CORS
 * and the same immutable Cache-Control as Nginx, so local behaviour matches.
 *
 * The folder is resolved from Vite's own project root, not from this file's location:
 * Vite bundles the config (and this import with it) into a temporary file under
 * `node_modules`, so `import.meta.url` cannot be trusted here.
 *
 * Never used in a deployed build: it only adds middleware to the local dev and
 * preview servers.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { Connect, Plugin } from 'vite';

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? undefined : TYPES[path.slice(dot)]) ?? 'application/octet-stream';
}

/** Resolve a URL path under `root`, or null if it escapes the folder or is not a file. */
export function resolveModelFile(urlPath: string, root: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const base = resolve(root);
  const full = normalize(join(base, decoded));
  if (full !== base && !full.startsWith(base + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function handler(prefix: string, modelsDir: string): Connect.NextHandleFunction {
  let warned = false;
  return (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith(prefix)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const file = resolveModelFile(url.slice(prefix.length), modelsDir);
    if (!file) {
      if (!warned) {
        warned = true;
        // One line is enough to explain a run where every model request 404s.
        console.warn(`[serve-models] ${url} not found under ${modelsDir}${existsSync(modelsDir) ? '' : ' (that folder does not exist)'}`);
      }
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', contentType(file));
    res.setHeader('Content-Length', String(statSync(file).size));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };
}

export function serveModels(base = '/'): Plugin {
  const prefix = `${base.replace(/\/*$/, '/')}models/`;
  return {
    name: 'birdbrain-serve-models',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(handler(prefix, join(server.config.root, 'models')));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler(prefix, join(server.config.root, 'models')));
    },
  };
}
