import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addV3Labels, loadLabels, parseLabels } from '../src/labels.js';

describe('Ask knows birds from both models (DECISIONS.md #136)', () => {
  const v24 = parseLabels(['Accipiter cooperii_Cooper’s Hawk', 'Acanthis flammea_Common Redpoll', 'Dog_Dog']);
  const v3 = { classes: [['Astur cooperii', 'Cooper’s Hawk', 'Aves', 1], ['Acanthis flammea', 'Redpoll', 'Aves', 2], ['Lithobates catesbeianus', 'American Bullfrog', 'Amphibia', 3], ['Siren', 'Siren', 'Anthropogenic', -1]] };

  it('adds V3.0’s new and renamed species, keeps V2.4’s English names, leaves out sound classes', () => {
    const both = addV3Labels(v24, v3);
    expect(both.byScientific.get('Astur cooperii')).toBe('Cooper’s Hawk');
    expect(both.byScientific.get('Accipiter cooperii')).toBe('Cooper’s Hawk');
    expect(both.byScientific.get('Acanthis flammea')).toBe('Common Redpoll');
    expect(both.byScientific.get('Lithobates catesbeianus')).toBe('American Bullfrog');
    expect(both.has('Siren')).toBe(false);
    expect(v24.has('Astur cooperii')).toBe(false); // the V2.4 list itself is not changed
  });

  it('refuses a file that is not V3.0’s list, and skips V3.0 when its file is missing', () => {
    expect(() => addV3Labels(v24, ['x'])).toThrow('classes');
    const dir = mkdtempSync(join(tmpdir(), 'labels-'));
    writeFileSync(join(dir, 'v24.json'), JSON.stringify(['Accipiter cooperii_Cooper’s Hawk']));
    writeFileSync(join(dir, 'v3.json'), JSON.stringify(v3));
    expect(loadLabels(join(dir, 'v24.json'), join(dir, 'v3.json')).has('Astur cooperii')).toBe(true);
    expect(loadLabels(join(dir, 'v24.json'), join(dir, 'missing.json')).has('Astur cooperii')).toBe(false);
  });

  it('reads the real V3.0 list shipped with the app', () => {
    const real = loadLabels(join(import.meta.dirname, '../../public/models/birdnet-v2.4/labels.json'), join(import.meta.dirname, '../../public/models/birdnet-v3.0/labels.json'));
    expect(real.has('Astur cooperii')).toBe(true);
    expect(real.has('Turdus migratorius')).toBe(true);
    expect(real.byScientific.size).toBeGreaterThan(11_000);
  });
});
