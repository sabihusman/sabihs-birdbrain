import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveModelFile } from '../scripts/serve-models.mts';

/** The dev/preview middleware serves local files, so its path handling is worth a test. */
describe('local model file server (scripts/serve-models.mts)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'bb-models-'));
    mkdirSync(join(root, 'birdnet-v2.4', 'mdata'), { recursive: true });
    writeFileSync(join(root, 'birdnet-v2.4', 'model.json'), '{}');
    writeFileSync(join(root, 'birdnet-v2.4', 'mdata', 'model.json'), '{}');
    writeFileSync(join(root, 'secret.txt'), 'not a model');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('serves files inside the models folder, including sub-folders', () => {
    expect(resolveModelFile('birdnet-v2.4/model.json', root)).toContain('model.json');
    expect(resolveModelFile('birdnet-v2.4/mdata/model.json', root)).toContain(join('mdata', 'model.json'));
    expect(resolveModelFile('birdnet-v2.4%2Fmodel.json', root)).toContain('model.json');
  });

  it('refuses anything outside the folder, a directory, or a missing file', () => {
    expect(resolveModelFile('../secret.txt', root)).toBeNull();
    expect(resolveModelFile('birdnet-v2.4/../../secret.txt', root)).toBeNull();
    expect(resolveModelFile('%2e%2e/secret.txt', root)).toBeNull();
    expect(resolveModelFile('birdnet-v2.4', root)).toBeNull();
    expect(resolveModelFile('birdnet-v2.4/nope.bin', root)).toBeNull();
    expect(resolveModelFile('%zz', root)).toBeNull();
  });
});
