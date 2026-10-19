import type { View, ViewContext } from '../app';
import { el } from '../dom';

export function helpView(_ctx: ViewContext): View {
  const root = el(
    'div',
    null,
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'How it works'),
      el('p', null, 'Your phone records sound, resamples it to 48 kHz mono and cuts it into overlapping 3-second windows. Each window goes through BirdNET V2.4, a neural network from the Cornell Lab of Ornithology and Chemnitz University of Technology, running entirely in your browser with TensorFlow.js. A second, tiny model uses your location and the week of the year to drop species that are not expected there.'),
      el('p', null, 'Nothing is uploaded. Audio, recordings and detections stay in this browser’s storage.'),
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
      el('h2', null, 'Why this ID'),
      el('p', null, 'On saved recordings you can run an occlusion analysis: regions of the spectrogram are silenced one at a time and the model is re-run. Regions whose removal lowers the confidence most are drawn in the species colour. It is slow on phones, so the grid is coarse by default (Settings).'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', null, 'Credits and licences'),
      el('p', null, 'BirdNET models © Stefan Kahl, Cornell Lab of Ornithology and Chemnitz University of Technology, licensed ', el('a', { href: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', target: '_blank', rel: 'noopener' }, 'CC BY-NC-SA 4.0'), ' (non-commercial). App code is MIT licensed. Map data © OpenStreetMap contributors. Species text and images from Wikipedia and Wikimedia Commons, each under its own licence.'),
      el('p', null, el('a', { href: 'https://github.com/sabihusman/sabihs-birdbrain', target: '_blank', rel: 'noopener' }, 'Source code on GitHub')),
    ),
  );
  return { el: root };
}
