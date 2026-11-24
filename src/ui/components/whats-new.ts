import birdampShotUrl from '../../assets/whats-new-birdamp.jpg';
import type { Audience, WhatsNewCard, WhatsNewEntry } from '../../app/whats-new';
import { birdAmpBolt } from '../birdamp/icon';
import { el } from '../dom';

/**
 * What's new on screen (DECISIONS.md #112): the quiet one-line strip on Listen (design B) and the swipe cards it
 * opens (design C). The strip covers nothing; the cards open only on "See ›" (or from Settings › What's new).
 */

export interface CardActions {
  /** "Don't show me this again": no more pop-ups (Sabih's option 1). */
  onMute: () => void;
  onSignUp: () => void;
  onSignIn: () => void;
  onTryBirdAmp: () => void;
  /** The bird-model announcement's "Use the smaller model": back to BirdNET V2.4 (DECISIONS.md #136). */
  onUseSmallerModel: () => void;
}

/** The bird-model mark: a small microphone on green, for the V3.0 announcement. */
const MODEL_ICON = (size: number) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><rect width="24" height="24" rx="6" fill="#2f7a55"/><path d="M12 5.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0V8A2.5 2.5 0 0 1 12 5.5zM7.5 11.5a4.5 4.5 0 0 0 9 0M12 16v2.5" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`;
const iconFor = (kind: WhatsNewEntry['icon'], size: number) => (kind === 'model' ? MODEL_ICON(size) : birdAmpBolt(size));

/** The line on Listen. `onSee` opens the cards; × only closes (the strip already counts as seen). */
export function whatsNewStrip(text: string, onSee: () => void, onClose: () => void, kind: WhatsNewEntry['icon'] = 'bolt'): HTMLElement {
  const icon = el('span', { class: 'wn-strip-icon' });
  icon.innerHTML = iconFor(kind, 22);
  const see = el('button', { class: 'wn-strip-see', type: 'button', 'data-testid': 'whats-new-see' }, 'See ›');
  const close = el('button', { class: 'wn-strip-close', type: 'button', 'aria-label': 'Close', 'data-testid': 'whats-new-close' }, '×');
  const strip = el('div', { class: 'wn-strip', role: 'status', 'data-testid': 'whats-new-strip' }, icon, el('span', { class: 'wn-strip-text' }, text), see, close);
  see.addEventListener('click', onSee);
  close.addEventListener('click', () => {
    strip.remove();
    onClose();
  });
  return strip;
}

/** The V3.0 announcement's picture: BirdNET's own test scores, as bars (WABAD: 0.552 against 0.272, DECISIONS.md #133). */
function modelArt(): HTMLElement {
  const row = (name: string, birds: string, percent: number, on: boolean) => {
    const fill = el('i');
    fill.style.width = `${percent}%`;
    return el('div', { class: `wn-model-row${on ? ' on' : ''}` }, el('div', { class: 'wn-model-name' }, el('strong', null, name), el('span', { class: 'muted' }, birds)), el('div', { class: 'wn-model-bar' }, fill));
  };
  return el(
    'div',
    { class: 'wn-art wn-model', 'aria-hidden': 'true' },
    el('p', { class: 'wn-art-title' }, 'Score in BirdNET’s tests'),
    row('BirdNET+ V3.0', '9,788 birds', 100, true),
    row('BirdNET V2.4', '6,509 birds', Math.round((0.272 / 0.552) * 100), false),
    el('p', { class: 'small muted' }, 'Real recordings from 66 sites on six continents'),
  );
}

function art(kind: WhatsNewCard['art']): HTMLElement {
  if (kind === 'birdamp') return el('img', { class: 'wn-shot', src: birdampShotUrl, alt: 'BirdAmp while listening: the clock, the waveform, the spectrogram and the player buttons', width: '660', height: '602' });
  if (kind === 'model') return modelArt();
  if (kind === 'ask') {
    return el(
      'div',
      { class: 'wn-art wn-ask', 'aria-hidden': 'true' },
      el('p', { class: 'wn-art-title' }, 'Ask about this bird'),
      el('p', { class: 'wn-q' }, 'Why does it sing at night?'),
      el('p', { class: 'wn-a' }, 'Robins often sing under street lights, where it never gets fully dark… ', el('span', { class: 'muted' }, '· AI answer, from Wikipedia')),
    );
  }
  return el(
    'div',
    { class: 'wn-art wn-map', 'aria-hidden': 'true' },
    el('i', { class: 'wn-heat' }),
    el('i', { class: 'wn-pin wn-pin-1' }),
    el('i', { class: 'wn-pin wn-pin-2' }),
    el('i', { class: 'wn-pin wn-pin-3' }),
    el('span', { class: 'wn-map-cap' }, 'Northern Cardinal · heard 14 times'),
  );
}

/**
 * The swipe cards, full screen, as a modal dialog. Cards scroll sideways with snap points (a native swipe);
 * "Next ›" steps; the last card has the audience's buttons. Escape, Close or a button closes it.
 */
export function openWhatsNewCards(entry: WhatsNewEntry, audience: Audience, actions: CardActions): () => void {
  const cards = entry.cards?.[audience] ?? [];
  const previous = document.activeElement as HTMLElement | null;
  const closeBtn = el('button', { class: 'wn-close', type: 'button', 'data-testid': 'whats-new-cards-close' }, 'Close ×');
  const counter = el('span', { class: 'muted small', 'aria-live': 'polite' }, '');
  const track = el('div', { class: 'wn-track', 'data-testid': 'whats-new-track' });
  const dots = el('div', { class: 'wn-dots', 'aria-hidden': 'true' });
  const next = el('button', { class: 'btn primary block', type: 'button', 'data-testid': 'whats-new-next' }, 'Next ›');
  const lastActions = el('div', { class: 'wn-actions', 'data-testid': 'whats-new-actions' });
  const fine = el('p', { class: 'small muted wn-fine', hidden: true }, 'Free, no ads. Sabih approves new accounts, so it can take a little while. Listening never needs an account.');
  const mute = el('button', { class: 'btn text wn-mute', type: 'button', 'data-testid': 'whats-new-mute' }, 'Don’t show me this again');
  const title = `wn-title-${entry.id}`;
  const dialog = el('div', { class: 'wn-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title, 'data-testid': 'whats-new-cards' }, el('div', { class: 'wn-top' }, counter, closeBtn), track, dots, next, lastActions, fine, el('div', { class: 'wn-foot' }, mute));

  cards.forEach((c, i) => {
    const eyebrow = el('p', { class: 'wn-eyebrow' });
    eyebrow.innerHTML = iconFor(entry.icon, 16);
    eyebrow.append(entry.kind === 'new' ? 'New this month' : 'What’s new');
    track.appendChild(el('section', { class: 'wn-card', 'data-testid': 'whats-new-card', 'aria-roledescription': 'card', 'aria-label': `${i + 1} of ${cards.length}` }, eyebrow, el('h2', { id: i === 0 ? title : undefined }, c.title), el('p', { class: 'wn-text' }, c.text), art(c.art)));
    dots.appendChild(el('i'));
  });

  const btn = (label: string, cls: string, testid: string, fn: () => void) => {
    const b = el('button', { class: `btn ${cls}`, type: 'button', 'data-testid': testid }, label);
    b.addEventListener('click', () => {
      close();
      fn();
    });
    return b;
  };
  if (audience === 'signed-out') lastActions.append(btn('Create free account', 'primary', 'whats-new-signup', actions.onSignUp), btn('Sign in', '', 'whats-new-signin', actions.onSignIn));
  else if (entry.actions === 'model') lastActions.append(btn('Got it', 'primary', 'whats-new-ok', () => undefined), btn('Use the smaller model', '', 'whats-new-smaller', actions.onUseSmallerModel));
  else if (audience === 'member') lastActions.append(btn('Try BirdAmp', 'primary', 'whats-new-try', actions.onTryBirdAmp), btn('Keep my layout', '', 'whats-new-keep', () => undefined));
  else lastActions.append(btn('OK', 'primary', 'whats-new-ok', () => undefined));

  let index = 0;
  const show = (i: number) => {
    index = Math.max(0, Math.min(cards.length - 1, i));
    counter.textContent = cards.length > 1 ? `${index + 1} of ${cards.length}` : '';
    Array.from(dots.children).forEach((d, k) => d.classList.toggle('on', k === index));
    dots.hidden = cards.length < 2;
    const last = index === cards.length - 1;
    next.hidden = last;
    lastActions.hidden = !last;
    fine.hidden = !last || audience !== 'signed-out';
  };
  // A swipe moves the dots; while "Next ›" is sliding the track, its own scroll events are ignored, or a
  // quick second tap would be undone halfway through the slide.
  let ignoreScrollUntil = 0;
  const syncFromScroll = () => {
    const i = Math.round(track.scrollLeft / (track.clientWidth || 1));
    if (i !== index) show(i);
  };
  track.addEventListener('scroll', () => {
    if (Date.now() < ignoreScrollUntil) return;
    syncFromScroll();
  });
  next.addEventListener('click', () => {
    show(index + 1);
    ignoreScrollUntil = Date.now() + 700;
    track.scrollTo?.({ left: index * track.clientWidth, behavior: matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' && index < cards.length - 1) next.click();
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('wn-open');
    dialog.remove();
    previous?.focus?.();
  }
  closeBtn.addEventListener('click', close);
  mute.addEventListener('click', () => {
    actions.onMute();
    close();
  });
  document.addEventListener('keydown', onKey);
  document.documentElement.classList.add('wn-open');
  document.body.appendChild(dialog);
  show(0);
  closeBtn.focus();
  return close;
}
