import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { resolveModelFile, serveModels } from '../scripts/serve-models.mts';

/** The dev/preview middleware serves local files, so its path handling is worth a test. */
const BODY = '{"format":"graph-model"}';
type Middleware = (req: unknown, res: unknown, next: () => void) => void;

let root: string;
let models: string;

/** Install the plugin's middleware through one of its two hooks, with a fake Vite server. */
async function middlewareFrom(hook: 'configureServer' | 'configurePreviewServer'): Promise<Middleware> {
  const plugin: Plugin = serveModels('/');
  const added: Middleware[] = [];
  const server = { middlewares: { use: (fn: Middleware) => added.push(fn) }, config: { root } };
  // The hooks only read `middlewares` and `config.root`; the cast keeps the fake small.
  await (plugin[hook] as unknown as (s: typeof server) => unknown).call(plugin, server);
  expect(added, hook).toHaveLength(1);
  return added[0];
}

interface Capture {
  status: number;
  headers: Record<string, string>;
  body: string;
  nexted: boolean;
}

/** Drive one request through the middleware and collect what it answered. */
function request(mw: Middleware, url: string, method = 'GET'): Promise<Capture> {
  return new Promise<Capture>((done) => {
    const out: Capture = { status: 200, headers: {}, body: '', nexted: false };
    const res = {
      get statusCode() {
        return out.status;
      },
      set statusCode(v: number) {
        out.status = v;
      },
      setHeader: (k: string, v: string) => {
        out.headers[k] = v;
      },
      write: (c: Buffer | string) => {
        out.body += c.toString();
        return true;
      },
      end: (s?: string) => {
        if (s) out.body += s;
        done(out);
      },
      on: () => res,
      once: () => res,
      emit: () => false,
      writeHead: () => res,
      destroy: () => undefined,
    };
    mw({ url, method }, res, () => {
      out.nexted = true;
      done(out);
    });
  });
}

describe('local model file server (scripts/serve-models.mts)', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-root-'));
    models = join(root, 'models');
    mkdirSync(join(models, 'birdnet-v2.4', 'mdata'), { recursive: true });
    writeFileSync(join(models, 'birdnet-v2.4', 'model.json'), BODY);
    writeFileSync(join(models, 'birdnet-v2.4', 'mdata', 'model.json'), '{}');
    writeFileSync(join(models, 'secret.txt'), 'not a model');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('serves files inside the models folder, including sub-folders', () => {
    expect(resolveModelFile('birdnet-v2.4/model.json', models)).toContain('model.json');
    expect(resolveModelFile('birdnet-v2.4/mdata/model.json', models)).toContain(join('mdata', 'model.json'));
    expect(resolveModelFile('birdnet-v2.4%2Fmodel.json', models)).toContain('model.json');
  });

  it('refuses anything outside the folder, a directory, or a missing file', () => {
    expect(resolveModelFile('../secret.txt', models)).toBeNull();
    expect(resolveModelFile('birdnet-v2.4/../../secret.txt', models)).toBeNull();
    expect(resolveModelFile('%2e%2e/secret.txt', models)).toBeNull();
    expect(resolveModelFile('birdnet-v2.4', models)).toBeNull();
    expect(resolveModelFile('birdnet-v2.4/nope.bin', models)).toBeNull();
    expect(resolveModelFile('%zz', models)).toBeNull();
  });

  /**
   * The folder must come from Vite's project root: Vite bundles the config into a temp
   * file under node_modules, so a path derived from this module's own URL points at the
   * wrong place and every model request 404s (seen in CI on 2026-10-20).
   */
  it.each(['configureServer', 'configurePreviewServer'] as const)('serves the model from the Vite server root (%s)', async (hook) => {
    const got = await request(await middlewareFrom(hook), '/models/birdnet-v2.4/model.json');
    expect(got.nexted).toBe(false);
    expect(got.status).toBe(200);
    expect(got.headers['Content-Type']).toBe('application/json');
    expect(Number(got.headers['Content-Length'])).toBe(BODY.length);
    expect(got.headers['Cache-Control']).toContain('immutable');
    expect(got.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(got.body).toContain('graph-model');
  });

  it('passes on what it does not hold: labels.json and LICENSE.md live in public/', async () => {
    const mw = await middlewareFrom('configurePreviewServer');
    for (const url of ['/models/birdnet-v2.4/labels.json', '/models/birdnet-v2.4/LICENSE.md', '/index.html']) {
      expect((await request(mw, url)).nexted, url).toBe(true);
    }
    // A write method is not ours to answer either.
    expect((await request(mw, '/models/birdnet-v2.4/model.json', 'POST')).nexted).toBe(true);
  });

  it('answers a preflight without touching the disk', async () => {
    const got = await request(await middlewareFrom('configurePreviewServer'), '/models/birdnet-v2.4/model.json', 'OPTIONS');
    expect(got.status).toBe(204);
    expect(got.headers['Access-Control-Allow-Methods']).toBe('GET, HEAD, OPTIONS');
  });
});
