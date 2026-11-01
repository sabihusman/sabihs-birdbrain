import { describeAiServices, refreshAiServices, storedAiServices } from '../../api/ai-services';
import type { View, ViewContext } from '../app';
import { el } from '../dom';
import { PIPELINE_STAGES } from '../viz/pipeline-state';

export function helpView(_ctx: ViewContext): View {
  // Named from the server's list (DECISIONS.md #90): the stored copy at once, the server's answer when it arrives.
  const aiServices = el('span', { 'data-testid': 'help-ai-services' }, describeAiServices(storedAiServices()));
  void refreshAiServices().then((list) => (aiServices.textContent = describeAiServices(list)));
  const root = el(
    'div',
    null,
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'How it works'),
      el('p', null, 'Your phone cuts sound into overlapping 3 s windows and BirdNET V2.4 (Cornell Lab of Ornithology, Chemnitz University of Technology) identifies each one in your browser. A second small model uses your location and the week to drop unlikely species.'),
      el('p', null, 'Nothing is uploaded: audio and sightings stay in this browser. Recordings are saved as 16-bit WAV at 48 kHz.'),
      el('p', null, 'Map › Places groups sightings into areas about 1 km across (a sighting joins an area within 1 km of its centre, or starts one). To name each, it sends the centre, rounded to ~100 m, to OpenStreetMap’s Nominatim, one at a time. Names are saved for 180 days.'),
      el('p', null, 'On Species, ✓ marks birds you’ve spotted and “Spotted by me” lists them. Members tap ✓ for the ID card. Ticks never leave this phone.'),
    ),
    // The 1–7 steps, moved here from the Listen screen (DECISIONS.md #109); the chips on Listen light up in this order.
    el(
      'section',
      { class: 'card', id: 'how-birdnet-decides', 'data-testid': 'help-steps' },
      el('h2', null, 'How BirdNET decides'),
      el('ol', { class: 'help-steps' }, ...PIPELINE_STAGES.map((s) => el('li', null, el('strong', null, s.title), ': ', s.text))),
      el('p', { class: 'small muted' }, 'BirdNET says which species are in each 3 s window. It can’t separate overlapping calls or count birds.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'What it cannot do'),
      el('ul', null, el('li', null, el('strong', null, 'Overlapping calls. '), 'It can’t separate overlapping calls, count birds or say which bird made which sound.'), el('li', null, el('strong', null, 'Background listening. '), 'iPhones pause web audio when the screen locks or you switch apps; keep the app open and the screen on.'), el('li', null, el('strong', null, 'Accuracy. '), 'Confidence isn’t the chance of being right. Rare birds, mimics, weak mics, wind and distance cause mistakes; treat results as suggestions.'), el('li', null, el('strong', null, 'Storage. '), 'iPhones may clear unused website data even with persistent storage. Export what you want to keep.')),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Friends (members)'),
      el('p', null, 'On My account (Settings › Account) you set a display name, change your password, invite friends by email, answer invites and choose who sees your list. Members accept on My account; others get a sign-up link, become friends once Sabih approves them, and choose then whether to share back. 10 invites a day, valid 30 days.'),
      el('p', null, 'Sharing is off until you turn it on. Then only each species’ name and the day you last spotted it are uploaded, replaced after each sighting: no times, places, recordings or counts. Friends see “Spotted by …” on Species and on each species page.'),
      el('p', null, 'Turning sharing off, or deleting your account, removes it from the server at once. Recordings stay on this phone until you delete them (Settings › Data).'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Ask about this bird (members)'),
      el('p', null, 'Members can ask about a bird on its page. The server fetches Wikipedia (biology), NatureServe (conservation status) and eBird (sightings, last 30 days); the answer comes from ', aiServices, ', using those only, naming each fact’s source and saying when they differ. Cached: Wikipedia 7 days, NatureServe 30, eBird 1 hour.'),
      el('p', null, 'Sent: the species, your question and your state/province (US-IA, US-IL, US-WA, CA-AB, CA-ON, else “none”). “Near me” questions add your position rounded to ~10 km. Nothing else; the note under the box shows exactly what’s sent.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Why this ID'),
      el('p', null, 'On a saved recording, Why this ID mutes one part at a time and re-runs the model; the parts that mattered most are outlined in the bird’s colour. Medium detail by default (Settings › Analysis).'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Credits and licences'),
      el('p', null, 'BirdNET models © Stefan Kahl, Cornell Lab of Ornithology and Chemnitz University of Technology, licensed ', el('a', { href: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', target: '_blank', rel: 'noopener' }, 'CC BY-NC-SA 4.0'), ' (non-commercial). App code is MIT licensed. Map tiles and place names © OpenStreetMap contributors, ', el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'ODbL'), '. Species text and images from Wikipedia and Wikimedia Commons, each under its own licence.'),
      el('p', null, el('a', { href: 'https://github.com/sabihusman/sabihs-birdbrain', target: '_blank', rel: 'noopener' }, 'Source code on GitHub')),
    ),
  );
  return { el: root };
}
