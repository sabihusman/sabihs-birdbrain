import { describeAiServices, refreshAiServices, storedAiServices } from '../../api/ai-services';
import type { View, ViewContext } from '../app';
import { el } from '../dom';

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
      el('p', null, 'Your phone records sound, resamples it to 48 kHz mono and cuts it into overlapping 3-second windows. Each window goes through BirdNET V2.4, a neural network from the Cornell Lab of Ornithology and Chemnitz University of Technology, running entirely in your browser with TensorFlow.js. A second, tiny model uses your location and the week of the year to drop species that are not expected there.'),
      el('p', null, 'Nothing is uploaded. Audio, recordings and detections stay in this browser’s storage.'),
      el('p', null, 'On the Map tab, the Places view groups your sightings into areas about 1 km across that never overlap: a sighting within 1 km of an area’s centre joins it, and a sighting further from every area starts a new one. To name each area, it sends the area’s centre, rounded to about 100 m, to OpenStreetMap’s Nominatim service, one request at a time; nothing else is sent. The names are kept on this phone for 180 days.'),
      el('p', null, 'On the Species tab a tick marks every species you have a sighting of, and the “Spotted by me” chip lists only those. Tapping a tick opens the species ID card for members; everyone else sees “Sign in to unlock”. The ticks are worked out from the sightings on this device and never leave it.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'What it cannot do'),
      el('ul', null, el('li', null, el('strong', null, 'Overlapping calls. '), 'BirdNET marks when each species is present in a window. It does not separate overlapping calls, count individuals or tell you which bird made which sound.'), el('li', null, el('strong', null, 'Background listening. '), 'iOS pauses web audio when the screen locks or the app goes to the background. Keep the app open and the screen on.'), el('li', null, el('strong', null, 'Accuracy. '), 'Confidence is not probability of being right. Rare species, mimics, poor microphones, wind and distance all cause mistakes. Treat results as suggestions to verify, not records.'), el('li', null, el('strong', null, 'Storage. '), 'iOS may clear website data that has not been used for a while, even when persistent storage was granted. Export recordings you care about.')),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Friends (members)'),
      el('p', null, 'On My account (Settings › Account › My account) you can set a display name, change your password, invite a friend by email, accept or decline invites, and stop or restart sharing your list with each friend. An approved member gets an email and accepts on their My account page. Someone without an account gets a link to create one; the app tells you so, and you become friends once Sabih approves their account. When they create it, they choose whether you see their list too. Invites expire after 30 days; you can send up to 10 a day.'),
      el('p', null, 'Sharing is off until you turn on “Share my species list with friends”. When it is on, the app uploads, for each species, only the scientific name and the date you last spotted it (the calendar day, no time): no places, no recordings, no counts, no history. The list is replaced after each new sighting. Friends see “Spotted by Alex, Sam” on the Species tab, the “Spotted by friends” chip, and a “Spotted by” list on each species page with one row per person and that one date.'),
      el('p', null, 'Turning sharing off removes the list from the server immediately, and so does “Delete account”, which also deletes your sign-in, friends and invites. Recordings and detections stay on this device until you delete them in Settings › Data.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Ask about this bird (members)'),
      el('p', null, 'On a species page, approved members can ask a question. The server passes it to ', aiServices, ', which answers from three sources, each with one role: Wikipedia for the biology (description, voice, range, behaviour, diet, status), NatureServe Explorer for the conservation status globally and in your state or province, and eBird for sightings reported in your state or province, and near you, in the last 30 days. Every fact is labelled with its source; when sources disagree the answer says “sources differ”. The model never calls these services itself; the server fetches them and caches them (Wikipedia 7 days, NatureServe 30 days, eBird 1 hour).'),
      el('p', null, 'What is sent: the species name, your question and your state/province code, worked out on the device from your location (US-IA, US-IL, US-WA, CA-AB or CA-ON; “none” elsewhere or when location is off). For questions about sightings near you (“near me”, “in my area”…), your position rounded to about 10 km is added. Never your exact location, and nothing else. The note under the question box shows exactly what the next question will send.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Why this ID'),
      el('p', null, 'On saved recordings you can run an occlusion analysis: regions of the spectrogram are silenced one at a time and the model is re-run. Regions whose removal lowers the confidence most are drawn in the species colour. It is slow on phones, so the grid is coarse by default (Settings).'),
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
