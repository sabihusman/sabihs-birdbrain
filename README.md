# Sabih’s Birdbrain

**Point your phone at the dawn chorus and see who is singing.** Sabih’s Birdbrain
is a progressive web app that identifies bird sounds in real time, entirely on
the device, using the BirdNET V2.4 neural network running in TensorFlow.js
inside a Web Worker. It records, re-analyses, explains its own identifications,
looks species up, maps where you heard them, and works offline once installed.

Live app: **https://sabihs-birdbrain.vercel.app**. API: `https://bird-brain.duckdns.org` (`server/`).

| Listen (light) | Listen (dark) | Species | Map |
| --- | --- | --- | --- |
| ![Listen view, light mode](docs/screenshots/listen-light.png) | ![Listen view, dark mode](docs/screenshots/listen-dark.png) | ![Species page](docs/screenshots/species-light.png) | ![Map view](docs/screenshots/map.png) |

| Recording analysed | “Why this ID” heatmap | Species search | Settings |
| --- | --- | --- | --- |
| ![Recording detail](docs/screenshots/recording-detail.png) | ![Occlusion heatmap over the spectrogram](docs/screenshots/why-this-id.png) | ![Species search](docs/screenshots/species-list.png) | ![Settings](docs/screenshots/settings.png) |

*Screenshots taken with Playwright at iPhone 13 size from the built app. The
species page shows the retry state because the build machine’s shared network
address was rate-limited by Wikipedia.*

## The problem

Bird-ID apps upload your audio to a server, need an account, or stop working
without signal. Good bioacoustic models exist and run fine on a phone, so the
interesting question was: how much of a complete field tool can be built as a
plain web page, with no backend and no data leaving the device, and can it also
*show* what the model is doing instead of just printing a name?

Constraints that shaped it:

- iOS Safari: the microphone needs HTTPS and a user gesture, web audio stops in
  the background, and storage can be evicted. The app is honest about all three.
- 78 MiB of model weights: downloaded once with a progress bar, then served from
  the browser cache.
- The BirdNET model is a Keras model with a custom spectrogram layer that has no
  TensorFlow.js implementation. It had to be re-implemented from the model’s own
  configuration and verified numerically.

## How it works

```mermaid
flowchart LR
    Mic["Microphone\n(getUserMedia)"] --> AW["AudioWorklet\nmono batches"]
    AW --> RS["Resample\n→ 48 kHz"]
    RS --> WIN["3 s windows\n1.5 s overlap"]
    WIN -->|"Float32Array\n(transferred)"| W

    subgraph W["Web Worker (TensorFlow.js: WebGL → WASM → CPU)"]
        direction LR
        STFT["Own FFT/STFT\n(real part)"] --> MEL["2 mel spectrograms\n96×511 each"]
        MEL --> NN["EfficientNet-B0-like\n6,522 sigmoid outputs"]
        GEO["Geo model\n(lat, lon, week)"] --> FLT["Location/season\nfilter ≥ 0.03"]
        NN --> FLT
    end

    FLT --> RES["Every species above\nthe threshold slider"]
    RES --> UI["Live list · spectrogram shading\n· confidence timeline"]
    RES --> DB[("IndexedDB\ndetections · recordings\n· Wikipedia cache")]
    DB --> MAP["Leaflet map\n(clustered markers)"]
    DB --> EXP["CSV / GeoJSON / WAV export"]
```

Every stage is visible in the app’s **How it works** panel, which lights up as
audio passes through, and in the live visualisation: a waveform, a scrolling
spectrogram drawn with the app’s own FFT (labelled as an approximation of the
model’s internal mel spectrograms), the sliding 3-second analysis window, colour
strips for the species found in each window, and a per-species confidence
timeline.

**Why this ID.** On a saved recording you can ask why the model thinks a window
contains, say, a House Finch. The app silences one time–frequency region at a
time, re-runs the model, and paints the regions whose removal hurt the
confidence most over the spectrogram in the species’ colour. It runs in the
worker with a progress bar and a cancel button; the grid is coarse by default
because each cell is a full model pass.

**Species colours.** Each species has a fixed colour derived from a hash of its
scientific name in OKLCH, chosen to read on both light and dark backgrounds.
The name is always shown next to the colour.

## Features

- **Listen:** three layouts (Consolidated, Bottom dock, Focus mode; Settings → Listen layout) around one Start/Stop action, result cards with Wikipedia thumbnails, a status line with words and an icon for every state (loading, ready, listening, paused, mic blocked with iPhone steps, error, offline), and the waveform, spectrogram, pipeline and timeline folded into "How it works". Also: multi-species results with
  confidences, confidence threshold slider, elapsed time, inference time,
  dropped-window count, screen wake lock (with a notice when unsupported),
  resume after returning to the foreground, a “Try the sample clip” demo,
  and a conditions indicator (Good / Too quiet / Windy, guidance only).
- **Microphone handling:** asks the browser for raw audio (echo cancellation,
  noise suppression and automatic gain off) and shows in Settings what was
  actually applied; a 150 Hz low-cut filter on the analysis path (default on)
  removes wind rumble from what the model hears while saved recordings stay
  unfiltered.
- **Location filter:** GPS plus BirdNET’s week-of-year (four per month) through
  the official geo model; manual coordinates or off when location is denied.
  The strongest filtered-out species is shown greyed so the filter is visible.
- **Recordings:** record WAV straight from the AudioWorklet stream (no
  MediaRecorder), import audio files, play back, re-analyse, export WAV,
  delete, optional auto-save of each 3 s detection window as a recording
  ("Auto-save 3-second detection windows as recordings", not to be confused
  with the species ID clip below). Opening a recording shows its **sighting
  card**: the bird's common and scientific names as the title, a map preview
  with one dot (tap to explore) above the coordinates, Copy and Google Maps
  buttons, the Plus Code under "More location details", the spectrogram with
  seek-by-tap, "Confidence 96% · your minimum 60%" and the matched 3 s windows
  as text, per-species detections, "Why this ID", an "About this bird" box
  (Wikipedia summary plus collapsed Description, Song and calls, Habitat and
  Diet sections, cached for offline) and, for members, "Ask about this bird".
- **Location sharing:** every located detection shows coordinates and a
  10-character Plus Code with copy buttons and an "Open in Google Maps" link.
- **Sightings:** consecutive detections of a species are merged into one
  sighting (peak confidence, first and last time, number of windows); a new
  sighting starts after 60 s without the species (adjustable). The map,
  the species pages, the clips and the CSV/GeoJSON exports all work in
  sightings; the per-window detections stay stored underneath.
- **Species ID card and sighting history (members):** on each species page, a
  card with the most recent sighting (map preview, coordinates, Google Maps
  link, Plus Code under "More location details", the same block as the
  sighting card) and the species' saved ID clip: up to 10 s of raw audio around
  the detection, with a spectrogram drawn from the clip, the 3 s window(s)
  that triggered the ID outlined and labelled with their confidence, a
  playback cursor, tap-to-seek and a tap-to-run "Why this ID" occlusion heat
  map on the identifying window. BirdNET marks *when* a species is heard, not
  which of the overlapping sounds it is, and the card says so. Tap the card
  for the full sighting history with a heat map / pin map of your own
  detections. One clip is kept per species and replaced only by a more
  confident detection. Free users see a short "Sign in to unlock" note
  instead.
- **Accounts (optional):** email + password + emailed code; approved members
  can ask AI questions about a species (on the species page and on each
  sighting card), answered only from its Wikipedia article with section
  citations; Sabih approves members on an admin page.
- **Species:** offline browser of the BirdNET classes, listing by default the
  species the location model expects near you in some week of the year
  ("312 local species · 6,511 total", with a "Show all species" toggle and a
  note when no location is available), with search by
  common or scientific name; Wikipedia summary (scientific name first, then
  common; disambiguation and not-found handled), image with Commons attribution
  link, cached for offline; your own detection count, first/last seen, mini map
  and links to recordings. Tapping a species anywhere opens its page.
- **Map:** OpenStreetMap with markers in species colours, clustering, species
  and date filters, tap a marker to open the species page. Attribution shown;
  tiles are never cached or prefetched.
- **Settings:** threshold (default 60 %; lower catches faint birds but adds
  false IDs), overlap, location source and manual coordinates,
  seasonal filter, species-range threshold, auto-save of detection windows
  (its own confidence bar, never below the threshold), compute backend,
  occlusion resolution, storage used vs available, `navigator.storage.persist()`
  result, CSV and GeoJSON export, delete all.
- **PWA:** manifest, icons, apple-touch-icon, service worker precaching the app
  shell and label list, cache-first model files, offline operation.

## Look and feel

Two themes from [docs/DESIGN_GUIDE.md](docs/DESIGN_GUIDE.md): "Forest Night"
(dark, the default whatever the phone prefers) and "Field Guide, cream". The
sun/moon button in the header switches; the choice is remembered on the
device and applied before the first paint. Both themes pass WCAG AA on the
token pairs and the species dots (checked by tests); screenshots of every
Listen state in both themes are in `docs/screenshots/`.

## Privacy

Audio is processed on the device and never uploaded: identification, saving
recordings and analysing imported clips (capped at 60 seconds) all happen in
your browser, for everyone, signed in or not. Recordings and detections live in
your browser's IndexedDB; you can export or delete them at any time.

What does leave the phone, and why:

- The one-time model download from the hosting origin, Wikipedia summaries
  when you open a species page, and OpenStreetMap tiles when you open the map.
- If you create an account (optional): your email address and password go to
  the Birdbrain API at `bird-brain.duckdns.org`, which emails you a 6-digit
  code on every sign-in and keeps a short-lived session token (the API only
  accepts requests from `https://sabihs-birdbrain.vercel.app`). New accounts
  wait for Sabih's approval.
- If you are an approved member and use "Ask about this bird": the species'
  scientific name, your question (up to 500 characters) and your
  state/province code are sent. The code is decided on the device from your
  location (`US-IA`, `US-IL`, `US-WA`, `CA-AB`, `CA-ON`, or `none` elsewhere
  or when location is off). For questions about sightings near you ("near
  me", "in my area"…) your position rounded to one decimal (about 10 km) is
  added; your exact location never is. The server fetches the relevant
  sections of the Wikipedia article (description, voice, range, behaviour,
  diet, status; capped, cached for seven days), the species' NatureServe
  Explorer conservation ranks (global and for your state/province; cached
  30 days) and, when the server has an eBird key, the recent eBird sightings
  in your state/province and near the rounded point (last 30 days; locality
  name, date and count only; cached one hour), then asks Google's Gemini
  model to answer from that text alone, labelling each fact with its source
  and saying "sources differ" when they disagree. The model never calls
  these services. The answer comes back as plain text with the cited
  sections and the sources used as links. When the article cannot be
  fetched, the summary is used; when NatureServe or eBird are unavailable,
  the answer says which sources it used. Questions are not logged. There are
  daily limits per person and overall.

- If you are an approved member and use **Friends** (Settings › Account):
  your display name is stored on the server and shown to friends instead of
  your email. Inviting a friend sends their address to the API, which always
  answers "Invite sent"; an email goes out only to an approved member who is
  not already your friend, and it names you by display name, never by email.
  Sharing is **off by default**. If you turn on "Share my species list with
  friends" (the switch says exactly what is shared: "which birds you've
  spotted and the date you last spotted each one"), the app uploads, for
  each species, only the scientific name and the calendar day of your most
  recent sighting (`YYYY-MM-DD`, local day, no time), replacing the whole
  list after each new sighting. No locations, no counts, no recordings or
  clips, no history of earlier sightings, and nothing about species you have
  not spotted. Only accepted friends can read it, and they see your display
  name with those pairs, nothing else. Turning the switch off removes the
  list from the server immediately; "Delete account" removes the list, your
  friendships and invites, your sessions and the account itself in one step.

Member features keep everything on the device too: the species ID card,
sighting history, heat map and the one saved clip per species are read from
IndexedDB and are never uploaded. The heat map in particular is sensitive
location data (it shows where you have been listening); it is built from your
own detections only, is not part of the exports, and signing out hides it
without deleting anything. Whether you are a member is decided from the
session cached on the device, so no request is made to check it.

No analytics, no ads, no third-party trackers. The API's design and its review
against the OWASP LLM Top 10 and ASVS are in [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- **No background listening.** iOS stops web audio when the screen locks or you
  switch apps. The app keeps the screen awake while listening (Wake Lock API)
  and tells you when it cannot.
- **No separation of overlapping calls.** BirdNET marks *when* each species is
  present in a 3-second window. It does not separate overlapping calls, count
  individuals or attribute sounds to birds.
- **iOS quirks.** The microphone needs HTTPS and a tap; the home-screen app may
  ask for permission again; Safari can delete site data that has not been used
  for a while even after persistent storage is granted (export what you care
  about); WebGL inside a Web Worker is worked around on Safari and falls back to
  WebAssembly, which is slower.
- **Accuracy.** Confidence is a model score, not a probability of being right.
  Expect confusions between similar species, false positives from mimics and
  noise, and misses for distant or faint birds. Treat results as prompts to
  verify, not records.
- **Speed.** The model is 0.83 GFLOPs per window. On a GPU-backed browser a
  window takes well under a second; on the WebAssembly fallback it can take
  several seconds, and windows that arrive while inference is busy are skipped
  (the count is shown).

## V2: a native iOS app

The web app proves the pipeline but cannot listen in the background. V2 is a
Swift/SwiftUI app with AVAudioEngine capture, the `audio` background mode, and
BirdNET on Core ML or TensorFlow Lite using the Neural Engine, which should be
roughly an order of magnitude faster and far lighter on the battery. It will
keep the same data model and import the PWA’s CSV/GeoJSON exports, use MapKit
instead of Leaflet, and share the species-colour and week-of-year functions so
both apps agree.

## Development

```
npm install
npm run dev            # http://localhost:5173/
npm run lint && npm run typecheck && npm test
npm run build          # typecheck + vite build → dist/
npm run preview        # serve the build at http://localhost:4173/
npm run test:e2e       # Playwright: loads the model, analyses the bundled sample, goes offline
cd server && npm install && npm test   # API unit + integration tests (fake mailer, in-memory SQLite)
```

Front-end build settings live in `.env.example` (`VITE_API_BASE_URL`,
`VITE_BASE_PATH`). The API is in `server/` with its own `README`-style notes in
`server/deploy/README.md`, `server/.env.example` (variable names only) and
`docs/SECURITY.md`.

Unit tests (Vitest) cover the FFT/STFT, resampling and windowing, threshold and
multi-label logic, the week-of-year calculation, species colours, WAV encoding
and decoding, occlusion masking, and CSV/GeoJSON export. The Playwright test
runs the built app in Chromium at iPhone size, waits for the models to load in
the worker, identifies the sample clip that ships with the official BirdNET
TF.js export (a redpoll), checks the WebAssembly fallback, then reloads offline
and does it again from the caches. GitHub Actions runs all of it on every push;
Vercel builds and deploys the front end from `main`.

Architecture notes for contributors are in [CLAUDE.md](CLAUDE.md); the build
decisions and their alternatives are in [DECISIONS.md](DECISIONS.md); sources,
versions and licences of everything third-party are in
[docs/SOURCES.md](docs/SOURCES.md).

## Licensing and credits

- **Application code:** MIT (see [LICENSE](LICENSE)).
- **BirdNET models** (`public/models/birdnet-v2.4/`, acoustic and
  location/season models, label list, and the sample clip): © the BirdNET team,
  Stefan Kahl et al., K. Lisa Yang Center for Conservation Bioacoustics at the
  Cornell Lab of Ornithology and Chemnitz University of Technology, licensed
  **CC BY-NC-SA 4.0**, non-commercial use only. They are not covered by the MIT
  licence. Taken from the official TensorFlow.js export in the
  [BirdNET-Analyzer](https://github.com/birdnet-team/BirdNET-Analyzer)
  repository (tag v1.5.1). Citation: Kahl, S., Wood, C. M., Eibl, M., & Klinck,
  H. (2021). *BirdNET: A deep learning solution for avian diversity monitoring.*
  Ecological Informatics, 61, 101236.
- **Map data:** © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors (ODbL), tiles from the OSM tile servers under their usage policy.
- **Species text:** Wikipedia, CC BY-SA 4.0. **Images:** Wikimedia Commons,
  each under its own licence, linked from every image.
- TensorFlow.js (Apache-2.0), Leaflet (BSD-2-Clause), Leaflet.markercluster
  (MIT), idb (ISC).
