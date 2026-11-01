import type { ListenLayout } from '../../app/settings';
import { el } from '../dom';
import { birdAmpBolt } from '../birdamp/icon';

/**
 * Settings → Listen layout: three preview tiles in one row (Consolidated, Bottom dock, Focus),
 * each a small phone wireframe plus the layout name. Replaces the dropdown (DECISIONS.md #45).
 *
 * The group is a radiogroup of radio buttons: the selected tile has aria-checked="true" and
 * tabindex 0, the others tabindex -1 (roving tabindex); Left/Right and Up/Down move the
 * selection, Space/Enter select the focused tile, and a tap switches at once.
 * The wireframes are inline SVG coloured only through CSS classes and theme tokens, so they
 * work in both themes and need no style attributes (the CSP has no 'unsafe-inline').
 */

/** `label` is the visible text (may hold a soft hyphen for 320 px screens); `name` is the accessible one. */
export const LAYOUT_OPTIONS: ReadonlyArray<{ value: ListenLayout; name: string; label?: string; description: string; membersOnly?: boolean }> = [
  { value: 'consolidated', name: 'Consolidated', label: 'Consoli\u00ADdated', description: 'Panel on top, results below' },
  { value: 'dock', name: 'Bottom dock', description: 'Results fill the screen, controls above the tabs' },
  { value: 'focus', name: 'Focus', description: 'One large card for the latest bird' },
  // Approved members only (Sabih's 3A, DECISIONS.md #110): signed out or waiting, the tile is not shown.
  { value: 'birdamp', name: 'BirdAmp', description: 'Winamp player + library', membersOnly: true },
];

/** Phone wireframes (52×73 viewBox). Classes are coloured in styles.css: wf-frame, wf-panel, wf-row, wf-tabs. */
const WIREFRAMES: Record<ListenLayout, string> = {
  // Control panel block on top, result rows below, tab bar at the bottom.
  consolidated:
    '<rect class="wf-frame" x="1" y="1" width="50" height="71" rx="7"/>' +
    '<rect class="wf-panel" x="6" y="8" width="40" height="20" rx="3"/>' +
    '<rect class="wf-row" x="6" y="33" width="40" height="8" rx="2"/>' +
    '<rect class="wf-row" x="6" y="45" width="40" height="8" rx="2"/>' +
    '<rect class="wf-row" x="6" y="57" width="40" height="4" rx="2"/>' +
    '<rect class="wf-tabs" x="6" y="65" width="40" height="3" rx="1.5"/>',
  // Result rows filling the screen, a control bar just above the tab bar.
  dock:
    '<rect class="wf-frame" x="1" y="1" width="50" height="71" rx="7"/>' +
    '<rect class="wf-row" x="6" y="8" width="40" height="8" rx="2"/>' +
    '<rect class="wf-row" x="6" y="20" width="40" height="8" rx="2"/>' +
    '<rect class="wf-row" x="6" y="32" width="40" height="8" rx="2"/>' +
    '<rect class="wf-row" x="6" y="44" width="40" height="4" rx="2"/>' +
    '<rect class="wf-panel" x="6" y="53" width="40" height="9" rx="2.5"/>' +
    '<rect class="wf-tabs" x="6" y="65" width="40" height="3" rx="1.5"/>',
  // One large card (photo block and two text lines) with a big button under it.
  focus:
    '<rect class="wf-frame" x="1" y="1" width="50" height="71" rx="7"/>' +
    '<rect class="wf-card" x="6" y="8" width="40" height="42" rx="4"/>' +
    '<rect class="wf-panel" x="10" y="12" width="32" height="20" rx="3"/>' +
    '<rect class="wf-row" x="10" y="36" width="24" height="4" rx="2"/>' +
    '<rect class="wf-row" x="10" y="43" width="16" height="3" rx="1.5"/>' +
    '<rect class="wf-panel" x="6" y="55" width="40" height="7" rx="3"/>' +
    '<rect class="wf-tabs" x="6" y="65" width="40" height="3" rx="1.5"/>',
  // Not a wireframe: BirdAmp is drawn with its gold bolt (layoutArt()).
  birdamp: '',
};

/** A layout's picture: the wireframe, or BirdAmp's bolt on its white tile. */
export function layoutArt(value: ListenLayout, width: number): string {
  if (value === 'birdamp') return birdAmpBolt(Math.round(width * 0.85));
  return layoutWireframeSvg(value, width);
}

/** One layout's wireframe as an SVG string at `width` px (the Listen layout bubble uses small ones, DECISIONS.md #101). */
export function layoutWireframeSvg(value: ListenLayout, width: number): string {
  const height = Math.round((width * 73) / 52);
  return `<svg class="layout-wireframe" viewBox="0 0 52 73" width="${width}" height="${height}" focusable="false" aria-hidden="true">${WIREFRAMES[value]}</svg>`;
}

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

export interface LayoutPicker {
  el: HTMLElement;
  /** Reflect a value chosen elsewhere (settings change) without emitting. */
  sync(value: ListenLayout): void;
  /** Show or hide the members-only tiles (the signed-in state changed). */
  setMember(member: boolean): void;
}

export function layoutPicker(initial: ListenLayout, onChange: (value: ListenLayout) => void, member = false): LayoutPicker {
  let current: ListenLayout = initial;
  let isMember = member;
  const shown = () => LAYOUT_OPTIONS.filter((o) => isMember || !o.membersOnly).map((o) => o.value);
  const tiles = new Map<ListenLayout, HTMLButtonElement>();

  const render = () => {
    for (const [value, tile] of tiles) {
      const on = value === current;
      tile.setAttribute('aria-checked', on ? 'true' : 'false');
      tile.tabIndex = on ? 0 : -1;
      tile.classList.toggle('selected', on);
      tile.hidden = !shown().includes(value);
    }
  };

  const choose = (value: ListenLayout, focus: boolean) => {
    if (value !== current) {
      current = value;
      render();
      onChange(value);
    }
    if (focus) tiles.get(value)?.focus();
  };

  const group = el('div', { class: 'layout-picker', role: 'radiogroup', 'aria-label': 'Listen layout', 'data-testid': 'listen-layout' });
  for (const opt of LAYOUT_OPTIONS) {
    const art = el('span', { class: 'layout-tile-art', 'aria-hidden': 'true' });
    art.innerHTML = `${opt.value === 'birdamp' ? `<span class="layout-bolt">${layoutArt('birdamp', 52)}</span>` : `<svg class="layout-wireframe" viewBox="0 0 52 73" width="52" height="73" focusable="false">${WIREFRAMES[opt.value]}</svg>`}<span class="layout-tile-check">${CHECK}</span>`;
    const tile = el(
      'button',
      {
        type: 'button',
        class: 'layout-tile',
        role: 'radio',
        'aria-checked': 'false',
        'aria-label': `${opt.name}: ${opt.description}`,
        'data-layout': opt.value,
        'data-testid': `listen-layout-${opt.value}`,
      },
      art,
      el('span', { class: 'layout-tile-name' }, opt.label ?? opt.name),
    );
    tile.addEventListener('click', () => choose(opt.value, true));
    tiles.set(opt.value, tile);
    group.appendChild(tile);
  }

  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0;
    if (step === 0) return;
    e.preventDefault();
    const order = shown();
    // Step from the focused tile (normally the selected one, since selecting moves focus).
    const from = (e.target as HTMLElement).closest<HTMLElement>('.layout-tile')?.dataset.layout as ListenLayout | undefined;
    const i = Math.max(0, order.indexOf(from ?? current));
    const next = step === -Infinity ? 0 : step === Infinity ? order.length - 1 : (i + step + order.length) % order.length;
    choose(order[next], true);
  });

  render();
  return {
    el: group,
    sync(value) {
      if (value === current) return;
      current = value;
      render();
    },
    setMember(m) {
      if (m === isMember) return;
      isMember = m;
      render();
    },
  };
}
