/**
 * Vite plugin: serve the repository's `models/` folder during `vite dev` and
 * `vite preview`, at `<base>models/`.
 *
 * In production those files come from the API host (src/model/model-source.ts) and are
 * deliberately not part of `dist/`, so without this plugin a local run or the
 * Playwright suite would have to download 78 MiB from the live server. It sends CORS
 * and the same immutable Cache-Control as Nginx, so local behaviour matches.
 *
 * Never used in a deployed build: it only adds middleware to the local dev and
 * preview servers.
 */
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';

const MODELS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), 'models');

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? undefined : TYPES[path.slice(dot)]) ?? 'application/octet-stream';
}

/** Resolve a URL path under MODELS_ROOT, or null if it escapes the folder or is missing. */
export function resolveModelFile(urlPath: string, root = MODELS_ROOT): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = normalize(join(root, decoded));
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

export function serveModels(base = '/'): Plugin {
  const prefix = `${base.replace(/\/*$/, '/')}models/`;
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
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
    const file = resolveModelFile(url.slice(prefix.length));
    if (!file) {
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
  return {
    name: 'birdbrain-serve-models',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
