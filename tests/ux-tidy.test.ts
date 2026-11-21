import { describe, expect, it } from 'vitest';
import { pillRepeatsTitle } from '../src/ui/status';
import { tabFor, type Route } from '../src/ui/router';
import { jumpTarget } from '../src/ui/components/jump-row';
import { layoutButtonText } from '../src/ui/components/layout-bubble';
import { LAYOUT_OPTIONS } from '../src/ui/components/layout-picker';
import { SETTINGS_JUMPS } from '../src/ui/views/settings';

describe('UX-audit tidy-up (DECISIONS.md #131)', () => {
  it('drops the status pill when it only repeats the heading, and keeps it when it adds something', () => {
    expect(pillRepeatsTitle('Not loaded', 'Model not loaded')).toBe(true);
    expect(pillRepeatsTitle('Mic blocked', 'Mic blocked')).toBe(true);
    expect(pillRepeatsTitle('Offline', 'Offline')).toBe(true);
    expect(pillRepeatsTitle('Model ready · webgl', 'Ready')).toBe(false);
    expect(pillRepeatsTitle('Model ready', 'Ready')).toBe(false);
    expect(pillRepeatsTitle('Loading model 40%', 'Loading the model')).toBe(false);
    // A model that failed to download: the pill names what failed under "Something went wrong".
    expect(pillRepeatsTitle('Model not loaded', 'Something went wrong')).toBe(false);
    expect(pillRepeatsTitle('', 'Ready')).toBe(false);
  });

  it('lights no tab on Help or the sign-in pages, and the parent tab on pages opened from a tab', () => {
    const none: Route[] = [{ name: 'help' }, { name: 'signin' }, { name: 'signup' }, { name: 'signup', invite: 'x' }, { name: 'forgot-password' }, { name: 'reset-password', token: 't' }];
    for (const r of none) expect(tabFor(r), r.name).toBe('none');
    expect(tabFor({ name: 'account' })).toBe('settings');
    expect(tabFor({ name: 'whats-new' })).toBe('settings');
    expect(tabFor({ name: 'admin-usage' })).toBe('settings');
    expect(tabFor({ name: 'recording', id: 'r1' })).toBe('recordings');
    expect(tabFor({ name: 'species-history', scientific: 'Turdus migratorius' })).toBe('species');
    for (const name of ['listen', 'recordings', 'species', 'map', 'settings'] as const) expect(tabFor({ name })).toBe(name);
  });

  it('names the layout on its button', () => {
    expect(layoutButtonText('Focus')).toBe('Layout: Focus');
    expect(LAYOUT_OPTIONS.map((o) => layoutButtonText(o.name))).toEqual(['Layout: Consolidated', 'Layout: Focus', 'Layout: BirdAmp']);
  });

  it('finds the card a jump button scrolls to by its exact heading', () => {
    const card = (text: string) => {
      const section = { id: text };
      return { textContent: ` ${text} `, closest: () => section };
    };
    const headings = [card('Detection'), card('Export'), card('Exporting')];
    const scope = { querySelectorAll: () => headings } as unknown as ParentNode;
    expect(jumpTarget(scope, 'Export')?.section).toMatchObject({ id: 'Export' });
    expect(jumpTarget(scope, 'Data')).toBeNull();
  });

  it('has a jump button for every Settings card, with short labels', () => {
    expect(SETTINGS_JUMPS.map(([label]) => label)).toEqual(['Account', 'Layout', 'Detection', 'Microphone', 'Location', 'Recording', 'Analysis', 'Storage', 'Export', 'Data', 'Privacy', 'About']);
    for (const [label] of SETTINGS_JUMPS) expect(label.length).toBeLessThanOrEqual(10);
  });
});
