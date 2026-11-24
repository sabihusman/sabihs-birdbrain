import type { AppController } from '../../app/controller';
import type { AuthUser } from '../../api/client';
import { canChooseModel } from '../../app/access';
import { MODEL_NAMES, V3_TOTAL_BYTES, type ModelId } from '../../model/v3';
import { MODEL_TOTAL_BYTES } from '../../model/constants';
import { mb } from '../model-progress';
import { el } from '../dom';

/**
 * Settings › Detection › "Bird model" (DECISIONS.md #133, #136): BirdNET+ V3.0 (the default) or the smaller V2.4.
 * Registered accounts (approved or waiting) see it; signed out it is hidden and V2.4 runs whatever is stored.
 */
export const MODEL_CHOICE_TEXT = {
  title: 'Bird model',
  v30: `Newer and more accurate in BirdNET’s own tests; knows about 9,800 birds, plus frogs, insects and other sounds. ${mb(V3_TOTAL_BYTES)} MB download.`,
  v24: `Smaller and lighter on older phones; knows about 6,500 birds. ${mb(MODEL_TOTAL_BYTES)} MB download.`,
  names: 'Birds saved with either model show under one name, so you can switch back and forth.',
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
    return el('label', { class: 'model-option' }, input, el('span', { class: 'model-option-text' }, el('span', { class: 'model-option-name' }, id === 'v2.4' ? `${MODEL_NAMES[id]} (smaller)` : MODEL_NAMES[id]), el('span', { class: 'small muted' }, line)));
  };
  const note = el('p', { class: 'small muted model-note', 'data-testid': 'model-note', role: 'status' }, '');
  const root = el(
    'div',
    { class: 'model-choice', 'data-testid': 'model-choice' },
    el('div', { class: 'model-choice-head' }, el('span', { class: 'model-choice-title', id: 'model-choice-title' }, MODEL_CHOICE_TEXT.title)),
    el('div', { role: 'radiogroup', 'aria-labelledby': 'model-choice-title', class: 'model-options' }, option('v3.0', MODEL_CHOICE_TEXT.v30), option('v2.4', MODEL_CHOICE_TEXT.v24)),
    note,
  );

  const render = () => {
    const allowed = canChooseModel(user());
    root.hidden = !allowed;
    const chosen = settings.get().birdnetModel;
    for (const [id, input] of radios) input.checked = id === chosen;
    const lines: string[] = [];
    if (controller.modelSwitchPending) lines.push(MODEL_CHOICE_TEXT.pending);
    lines.push(MODEL_CHOICE_TEXT.names);
    note.textContent = lines.join(' ');
    note.hidden = lines.length === 0;
  };
  const offs = [settings.on('change', render), controller.on('model', render), controller.on('stats', render)];
  render();
  return { el: root, render, dispose: () => offs.forEach((off) => off()) };
}
