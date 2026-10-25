import { describe, expect, it } from 'vitest';
import { whyExplanationText } from '../src/ui/why-text';
import { DEFAULT_SETTINGS, migrate } from '../src/app/settings';

describe('"Why this ID" explanation and default', () => {
  it('says where to look and what the outline and the darkening mean, in plain words', () => {
    const [result, howTo, grid] = whyExplanationText('Eurasian Collared-Dove', 0.68, 0.67, 0, 8, 6);
    expect(result).toBe('Eurasian Collared-Dove: 68% on 0:00–0:03. Muting the key part drops it by 67%.');
    expect(howTo).toBe('Outlined: what the ID relied on most. Darker: mattered less. Time runs left to right, pitch low to high.');
    expect(grid).toBe('8×6 grid · Settings › Analysis to change.');
  });
  it('defaults to Medium, moves every earlier phone to Medium once, and keeps a later choice', () => {
    expect(DEFAULT_SETTINGS.occlusionResolution).toBe('medium');
    expect(migrate({ version: 3, occlusionResolution: 'fine' }).occlusionResolution).toBe('medium');
    expect(migrate({ version: 4, occlusionResolution: 'fine' }).occlusionResolution).toBe('fine');
  });
});
