import type { AppController } from '../../app/controller';
import type { AuthUser } from '../../api/client';
import { canChooseModel } from '../../app/access';
import { MODEL_NAMES, V3_TOTAL_BYTES, type ModelId } from '../../model/v3';
import { MODEL_TOTAL_BYTES } from '../../model/constants';
import { mb } from '../model-progress';
import { el } from '../dom';

/**
 * Settings › Detection › "Bird model" (DECISIONS.md #133): V2.4, which everyone uses, or BirdNET+ V3.0 on test.
 * Only the approved admin sees it; for anyone else it is hidden and V2.4 runs whatever is stored.
 */
export const MODEL_CHOICE_TEXT = {
  title: 'Bird model',
  badge: 'Admin test',
  v24: `What everyone uses. ${mb(MODEL_TOTAL_BYTES)} MB download.`,
  v30: `Newer and more accurate in BirdNET’s own tests, with frogs, insects and other sounds too. ${mb(V3_TOTAL_BYTES)} MB download; may be too big for some phones.`,
  names: 'Some birds have new names in V3.0 (Cooper’s Hawk is now Astur cooperii), so a bird saved with V2.4 can show up as a different bird.',
  pending: 'Switches when you stop listening.',
} as const;

export function modelChoice(controller: AppController, user: () => AuthUser | null): { el: HTMLElement; render: () => void; dispose: () => void } {
  const settings = controller.settings;
  const radios = new Map<ModelId, HTMLInputElement>();
  const option = (id: ModelId, line: string) => {
    const input = el('input', { type: 'radio', name: 'birdnet-model', value: id, 'data-testid': `model-${id}` }) as HTMLInputElement;
    input.addEventListener('change', () => {
      if (input.checked) settings.update({ birdnetModel: id });
    });
    radios.set(id, input);
    return el('label', { class: 'model-option' }, input, el('span', { class: 'model-option-text' }, el('span', { class: 'model-option-name' }, id === 'v3.0' ? `${MODEL_NAMES[id]} (test)` : MODEL_NAMES[id]), el('span', { class: 'small muted' }, line)));
  };
  const note = el('p', { class: 'small muted model-note', 'data-testid': 'model-note', role: 'status' }, '');
  const root = el(
    'div',
    { class: 'model-choice', 'data-testid': 'model-choice' },
    el('div', { class: 'model-choice-head' }, el('span', { class: 'model-choice-title', id: 'model-choice-title' }, MODEL_CHOICE_TEXT.title), el('span', { class: 'pill pill-admin' }, MODEL_CHOICE_TEXT.badge)),
    el('div', { role: 'radiogroup', 'aria-labelledby': 'model-choice-title', class: 'model-options' }, option('v2.4', MODEL_CHOICE_TEXT.v24), option('v3.0', MODEL_CHOICE_TEXT.v30)),
    note,
  );

  const render = () => {
    const allowed = canChooseModel(user());
    root.hidden = !allowed;
    const chosen = settings.get().birdnetModel;
    for (const [id, input] of radios) input.checked = id === chosen;
    const lines: string[] = [];
    if (controller.modelSwitchPending) lines.push(MODEL_CHOICE_TEXT.pending);
    if (chosen === 'v3.0') lines.push(MODEL_CHOICE_TEXT.names);
    note.textContent = lines.join(' ');
    note.hidden = lines.length === 0;
  };
  const offs = [settings.on('change', render), controller.on('model', render), controller.on('stats', render)];
  render();
  return { el: root, render, dispose: () => offs.forEach((off) => off()) };
}
