import { describeApiError, type ApiClient } from '../../api/client';
import type { Species } from '../../model/labels';
import { el } from '../dom';

const MAX_QUESTION = 500;

/** Member-only "Ask about this bird". Answers are rendered as text, never HTML. */
export function askBox(api: ApiClient, species: Species): { el: HTMLElement; dispose: () => void } {
  const root = el('section', { class: 'card', 'data-testid': 'ask-box' });

  const render = () => {
    root.replaceChildren(el('h2', null, 'Ask about this bird'));
    const user = api.user;
    if (!user) {
      root.append(el('p', { class: 'small muted' }, 'Members can ask an AI questions about a species, answered only from its Wikipedia summary. ', el('a', { href: '#/settings' }, 'Sign in or create an account in Settings.')));
      return;
    }
    if (user.status !== 'approved') {
      root.append(el('p', { class: 'small muted' }, user.status === 'pending' ? 'Your account is awaiting approval; questions unlock once Sabih approves it.' : 'Your account cannot use member features.'));
      return;
    }
    const input = el('textarea', { rows: '3', maxlength: String(MAX_QUESTION), placeholder: `What would you like to know about the ${species.common}?`, 'aria-label': 'Your question', style: 'width:100%;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--surface);font:inherit' });
    const counter = el('span', { class: 'small muted' }, `0/${MAX_QUESTION}`);
    input.addEventListener('input', () => {
      counter.textContent = `${input.value.length}/${MAX_QUESTION}`;
    });
    const ask = el('button', { class: 'btn primary', type: 'submit' }, 'Ask');
    const answer = el('div', { class: 'stack', 'data-testid': 'ask-answer' });
    const form = el('form', { class: 'stack' }, input, el('div', { class: 'row between' }, counter, ask), answer, el('p', { class: 'small muted' }, 'Answers are AI-generated from the Wikipedia summary only and can be wrong. Check the source link. Only the species name and your question are sent to the server.'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q.length < 3) return;
      ask.disabled = true;
      answer.replaceChildren(el('p', { class: 'muted' }, 'Thinking…'));
      try {
        const res = await api.ask(species.scientific, q);
        const p = el('p', null);
        p.textContent = res.answer; // plain text only
        answer.replaceChildren(p, el('p', { class: 'small' }, 'Source: ', el('a', { href: res.source.url, target: '_blank', rel: 'noopener noreferrer' }, res.source.title || 'Wikipedia')));
      } catch (err) {
        answer.replaceChildren(el('p', { class: 'notice error' }, describeApiError(err)));
      } finally {
        ask.disabled = false;
      }
    });
    root.append(form);
  };

  render();
  const unsub = api.on('change', render);
  return { el: root, dispose: unsub };
}
