import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveModelFile, serveModels } from '../scripts/serve-models.mts';

/** The dev/preview middleware serves local files, so its path handling is worth a test. */
const BODY = '{"format":"graph-model"}';

describe('local model file server (scripts/serve-models.mts)', () => {
  let root: string;
  let models: string;
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
  it('resolves the folder from the Vite server root, in dev and in preview', async () => {
    for (const hook of ['configureServer', 'configurePreviewServer'] as const) {
      const plugin = serveModels('/');
      const added: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
      const fakeServer = { middlewares: { use: (fn: never) => added.push(fn) }, config: { root } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (plugin[hook] as any)!.call(plugin, fakeServer as any);
      expect(added, hook).toHaveLength(1);

      const chunks: string[] = [];
      const headers: Record<string, string> = {};
      let status = 200;
      const res = {
        set statusCode(v: number) {
          status = v;
        },
        get statusCode() {
          return status;
        },
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        end: (s?: string) => {
          if (s) chunks.push(s);
        },
        // createReadStream(...).pipe(res) needs these; collect what is written.
        write: (c: Buffer | string) => {
          chunks.push(c.toString());
          return true;
        },
        on: () => res,
        once: () => res,
        emit: () => false,
        writeHead: () => res,
        destroy: () => undefined,
      };
      let nexted = false;
      await new Promise<void>((done) => {
        const origEnd = res.end;
        res.end = (s?: string) => {
          origEnd(s);
          done();
        };
        added[0]({ url: '/models/birdnet-v2.4/model.json', method: 'GET' }, res, () => {
          nexted = true;
          done();
        });
      });
      expect(nexted, hook).toBe(false);
      expect(status, hook).toBe(200);
      expect(headers['Content-Type'], hook).toBe('application/json');
      expect(Number(headers['Content-Length']), hook).toBe(BODY.length);
      expect(headers['Cache-Control'], hook).toContain('immutable');
      expect(chunks.join(''), hook).toContain('graph-model');
    }
  });

  it('passes other URLs on to Vite', async () => {
    const plugin = serveModels('/');
    const added: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (plugin.configurePreviewServer as any)!.call(plugin, { middlewares: { use: (fn: never) => added.push(fn) }, config: { root } } as any);
    let nexted = false;
    added[0]({ url: '/index.html', method: 'GET' }, {} as never, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
  });
});
