import { describeApiError, type ApiClient } from '../../api/client';
import { describeRegion, isNearbyQuestion, regionFor, shapeAskRequest } from '../../geo/region';
import type { GeoLocation } from '../../model/geo';
import type { Species } from '../../model/labels';
import { creditsFor } from '../credits';
import { el } from '../dom';
import { answerCredits } from './source-credit';

const MAX_QUESTION = 500;

/**
 * Member-only "Ask about this bird". Answers are rendered as text, never HTML.
 * `location` returns the app's current position (GPS or manual) or null; only
 * the region code derived from it, and for nearby questions the position
 * rounded to 0.1°, ever leave the device (src/geo/region.ts).
 */
export function askBox(api: ApiClient, species: Species, location: () => GeoLocation | null = () => null): { el: HTMLElement; dispose: () => void } {
  const root = el('section', { class: 'card', 'data-testid': 'ask-box' });

  const render = () => {
    root.replaceChildren(el('h2', null, 'Ask about this bird'));
    const user = api.user;
    if (!user) {
      root.append(el('p', { class: 'small muted locked-note', 'data-testid': 'ask-locked' }, 'Sign in to ask. Members can ask an AI questions about a species, answered only from its Wikipedia article, its NatureServe conservation status and recent eBird sightings. ', el('a', { href: '#/signin' }, 'Sign in or create an account.')));
      return;
    }
    if (user.status !== 'approved') {
      root.append(el('p', { class: 'small muted locked-note', 'data-testid': 'ask-locked' }, user.status === 'pending' ? 'Sign in to ask: your account is awaiting approval, and questions unlock once Sabih approves it.' : 'Your account cannot use member features.'));
      return;
    }
    const input = el('textarea', { rows: '3', maxlength: String(MAX_QUESTION), placeholder: `What would you like to know about the ${species.common}?`, 'aria-label': 'Your question', style: 'width:100%;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--surface);font:inherit' });
    const counter = el('span', { class: 'small muted' }, `0/${MAX_QUESTION}`);
    const sent = el('p', { class: 'small muted', 'data-testid': 'ask-sent-note' });
    const describeSent = () => {
      const loc = location();
      const region = loc ? regionFor(loc.lat, loc.lon) : 'none';
      const nearby = loc && isNearbyQuestion(input.value);
      sent.textContent = `Sent to the server: the species name, your question, your state/province code: ${describeRegion(region)}${loc ? '' : ' (location is off or unknown)'}${nearby ? ', and because this looks like a question about sightings near you, your position rounded to about 10 km' : ''}. Nothing else; nearby questions (“near me”, “in my area”…) add the rounded position only while location is on.`;
    };
    input.addEventListener('input', () => {
      counter.textContent = `${input.value.length}/${MAX_QUESTION}`;
      describeSent();
    });
    describeSent();
    const ask = el('button', { class: 'btn primary', type: 'submit' }, 'Ask');
    const answer = el('div', { class: 'stack', 'data-testid': 'ask-answer' });
    const form = el(
      'form',
      { class: 'stack' },
      input,
      el('div', { class: 'row between' }, counter, ask),
      answer,
      el('p', { class: 'small muted' }, 'Answers are AI-generated and can be wrong. They draw on three sources, each for one thing: Wikipedia for the biology (description, voice, range, behaviour, diet, status), NatureServe Explorer for the conservation status globally and in your state or province, and eBird for sightings reported there (and near you) in the last 30 days. Every fact is labelled with its source; when sources disagree the answer says so. Check the links.'),
      sent,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q.length < 3) return;
      ask.disabled = true;
      answer.replaceChildren(el('p', { class: 'muted' }, 'Thinking…'));
      try {
        const req = shapeAskRequest(species.scientific, q, location());
        const res = await api.ask(req.species, req.question, { region: req.region, near: req.near });
        const p = el('p', null);
        p.textContent = res.answer; // plain text only
        const cites = res.citations ?? [];
        const citeLine = cites.length
          ? el('p', { class: 'small', 'data-testid': 'ask-citations' }, 'Sections cited: ', ...cites.flatMap((c, i) => [i ? ' · ' : '', el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.section)]))
          : null;
        const sources = res.sources?.length ? res.sources : [{ name: res.source.title || 'Wikipedia', url: res.source.url }];
        const sourceLine = el('p', { class: 'small', 'data-testid': 'ask-sources' }, 'Sources: ', ...sources.flatMap((s, i) => [i ? ' · ' : '', el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.name)]), res.context === 'summary' ? ' (Wikipedia summary only; the full article was unavailable)' : '');
        // Credit eBird and NatureServe only when this answer used them (DECISIONS.md #66); Wikipedia keeps its link above.
        const credit = answerCredits(creditsFor(res.sources));
        answer.replaceChildren(p, ...(citeLine ? [citeLine] : []), sourceLine, ...(credit ? [credit] : []));
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
