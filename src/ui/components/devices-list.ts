import type { BirdDevice } from '../../api/client';
import { describeApiError } from '../../api/client';
import type { SpeciesSharer } from '../../species/sharing';
import type { Notice } from '../../app/controller';
import { el, fmtDate } from '../dom';
import { askChoice } from './choice-sheet';
import { actionRow, rowGroup } from './rows';

/**
 * My account › "Your devices" (DECISIONS.md #139): the devices your bird list comes from, and "Forget" for the
 * others. This device cannot be forgotten from itself: its next sync would put its birds back.
 */

export const DEVICES_TEXT = {
  title: 'Your devices',
  intro: 'Your bird list is the birds from all of these together. Removing a bird on one device leaves it on the list while another device still has it.',
  none: 'Your list is sent from this device after your next sighting.',
} as const;

const birds = (n: number) => `${n} bird${n === 1 ? '' : 's'}`;

/** The muted line under a device: "12 birds · updated Nov 24, 2026", "this device". */
export function deviceHint(d: BirdDevice, thisDevice: boolean): string {
  const parts = [birds(d.count)];
  if (d.syncedAt != null) parts.push(`updated ${fmtDate(d.syncedAt)}`);
  if (thisDevice) parts.push('this device');
  return parts.join(' · ');
}

export function forgetText(d: BirdDevice): { title: string; lines: string[] } {
  return {
    title: `Forget “${d.label}”?`,
    lines: [
      d.count === 1 ? 'Its 1 bird leaves your list, unless another device has it too. Nothing on that device is deleted.' : `Its ${birds(d.count)} leave your list, unless another device has them too. Nothing on that device is deleted.`,
      d.syncedAt == null ? 'This list came from an earlier version of the app.' : 'If you use that device again while signed in, it adds its birds back.',
    ],
  };
}

export function devicesList(sharing: SpeciesSharer, notify: (n: Notice) => void): { el: HTMLElement; dispose: () => void } {
  const host = el('div', { 'data-testid': 'devices' });
  const render = () => {
    const list = sharing.devices();
    const rows = list.map((d) => {
      const self = d.id === sharing.deviceId;
      if (self) return el('div', { class: 'row-item row-static', 'data-testid': 'device-row' }, el('span', { class: 'row-label' }, el('span', null, d.label), el('span', { class: 'row-hint small muted' }, deviceHint(d, true))));
      const row = actionRow(`Forget ${d.label}`, { hint: deviceHint(d, false), testId: 'device-forget', onClick: () => void forget(d) });
      row.dataset.device = d.id;
      return row;
    });
    host.replaceChildren(rowGroup(DEVICES_TEXT.title, el('p', { class: 'small muted row-intro' }, DEVICES_TEXT.intro), ...(rows.length ? rows : [el('p', { class: 'small muted row-intro' }, DEVICES_TEXT.none)])));
  };
  const forget = async (d: BirdDevice) => {
    const text = forgetText(d);
    const answer = await askChoice({ title: text.title, lines: text.lines, testid: 'forget-device-sheet', choices: [{ id: 'forget', label: 'Forget', tone: 'danger' }, { id: 'cancel', label: 'Cancel', tone: 'plain' }] });
    if (answer !== 'forget') return;
    try {
      await sharing.forgetDevice(d.id);
      notify({ kind: 'info', text: `Forgot ${d.label}.` });
    } catch (e) {
      notify({ kind: 'error', text: describeApiError(e) });
    }
  };
  render();
  const off = sharing.on('change', render);
  return { el: host, dispose: off };
}
