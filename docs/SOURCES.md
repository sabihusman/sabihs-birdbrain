# Sources, versions and licences

Everything third-party that this app ships or depends on, with where it came
from and under which licence. Verified during the build on 2026-10-18 from
the VM; the GitHub repository was read through a blobless `git clone` because
the GitHub web UI and REST API were blocked by the session's network policy.

## BirdNET models (in `models/birdnet-v2.4/`, served from the API host; see DECISIONS.md #56)

| Item | Source | Version | Licence |
| --- | --- | --- | --- |
| Acoustic model, TF.js Layers format (`model.json`, 13 weight shards, 52,215,312 bytes) | `birdnet-team/BirdNET-Analyzer`, git tag `v1.5.1`, path `birdnet_analyzer/checkpoints/V2.4/BirdNET_GLOBAL_6K_V2.4_Model_TFJS/static/model/` | BirdNET GLOBAL 6K V2.4 (June 2023); converted with TensorFlow.js Converter v3.20.0 from Keras 2.13.1 | CC BY-NC-SA 4.0 |
| Location/season ("MData") model, TF.js Graph format (`mdata/model.json`, 8 shards, 29,546,297 bytes) | same tag, `.../static/model/mdata/` | V2.4 species range model (V2, Jan 2024 per `docs/models.rst`); converted with TF.js Converter v4.16.0 | CC BY-NC-SA 4.0 |
| Label list (`labels.json`, 6,522 entries, `Scientific name_Common name`) | same tag, `.../static/model/labels.json` (identical content to `BirdNET_GLOBAL_6K_V2.4_Labels.txt`) | V2.4 | CC BY-NC-SA 4.0 |
| Sample clip (`public/samples/birdnet-sample.wav`, 3 s, 48 kHz mono) | same tag, `.../static/sample.wav` | – | CC BY-NC-SA 4.0 (part of the same checkpoint folder) |

Licence confirmation: at tag `v1.5.1` the repository `LICENSE` file is the
full text of the Creative Commons Attribution-NonCommercial-ShareAlike 4.0
International Public License. The current `main` branch of BirdNET-Analyzer
has re-licensed the *code* under MIT (LICENSE dated 2024, birdnet-team), but
`docs/models.rst` on `main` states: "All models listed here are licensed under
the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
License (CC BY-NC-SA 4.0)". The checkpoints were removed from the repository
after v1.5.1 and are now distributed via Zenodo (https://zenodo.org/records/15050749
per the README) and Google Drive links in `docs/models.rst`. Zenodo was not
needed because the git history still contains the TF.js export.

Model facts taken from `docs/models.rst` and from `model.json` itself:

- Input: raw audio, shape `[batch, 144000]` float32 = 3.0 s at 48 kHz. The
  model normalises each window to [-1, 1] itself and builds its own
  spectrograms inside the graph (custom Keras layer `MelSpecLayerSimple`).
- Two mel spectrograms: fmin 0 Hz / fmax 3 kHz, FFT 2048, hop 278, 96 mel bins;
  and fmin 500 Hz / fmax 15 kHz, FFT 1024, hop 280, 96 mel bins. Both give
  96 x 511 frames. Learned non-linear magnitude scaling (Schlüter 2018).
- Backbone: EfficientNet-B0-like, 1024-d embedding, 0.826 GFLOPs.
- Output: `[batch, 6522]` after a per-class **sigmoid** (`CLASS_ACTIVATION`),
  so outputs are independent per-class confidences (multi-label). 11 of the
  classes are non-bird "non-event" classes (Dog, Engine, Noise, ...).
- Geo model input: `[batch, 3]` = latitude, longitude, week (1-48, four per
  month; -1 = no seasonal filter). Output `[batch, 6522]` sigmoid; BirdNET-
  Analyzer keeps species with score >= 0.03 (`sf_thresh` default).
- Total download: 81,761,609 bytes (~78 MiB) for both models plus topology.

Reference demo: `BirdNET_GLOBAL_6K_V2.4_Model_TFJS/static/main.js` at the same
tag shows how the BirdNET team feeds the model from JavaScript. Its custom
layer casts the complex STFT to float32, which in TensorFlow.js keeps the real
part (verified in `tfjs-backend-cpu/dist/kernels/Cast.js`). This app
re-implements the layer from the model's own configuration rather than copying
that file (it was published under CC BY-NC-SA, which would conflict with the
app's MIT licence); the real-part semantics were confirmed empirically (see
DECISIONS.md).

Citation: Kahl, S., Wood, C. M., Eibl, M., & Klinck, H. (2021). BirdNET: A
deep learning solution for avian diversity monitoring. Ecological Informatics,
61, 101236.

## BirdNET-Analyzer example soundscape (not shipped)

`birdnet_analyzer/example/soundscape.wav` (2 min, 48 kHz) from the `main`
branch (MIT-licensed code repository) was used only on the VM to validate the
spectrogram re-implementation; it is not included in this repository.

## "BirdNET Live"

The build spec mentions BirdNET Live as a reference. No repository named
`BirdNET-Live` or `birdnet-live` exists under `github.com/birdnet-team` (both
return not-found over git), so it could not be consulted. No code from any
BirdNET UI was copied.

## Runtime dependencies (npm)

| Package | Version | Licence | Use |
| --- | --- | --- | --- |
| @tensorflow/tfjs | 4.22.0 | Apache-2.0 | Model inference (WebGL/CPU backends, layers + graph loaders) |
| @tensorflow/tfjs-backend-wasm | 4.22.0 | Apache-2.0 | WebAssembly backend fallback (the three `.wasm` binaries are bundled) |
| leaflet | 1.9.4 | BSD-2-Clause | Maps |
| leaflet.markercluster | 1.5.3 | MIT | Marker clustering |
| idb | 8.0.4 | ISC | IndexedDB wrapper |

Dev/test: vite 7, vitest 5, typescript 5.9, vite-plugin-pwa 2 (Workbox),
@playwright/test 1.56.1, eslint 10 + typescript-eslint 8, tsx, fake-indexeddb.

## Web services called from the user's browser (never from a server)

- **Wikipedia REST API** `https://en.wikipedia.org/api/rest_v1/page/summary/{title}`
  for species summaries. Verified from the VM: responds with
  `access-control-allow-origin: *` (echoing the Origin on actual requests) and a
  preflight `access-control-allow-headers` list that includes `api-user-agent`,
  so the `Api-User-Agent` header can be sent from a browser. A disambiguation
  page returns HTTP 200 with `"type": "disambiguation"`; a missing page returns
  HTTP 404. The VM's shared egress address was rate-limited (HTTP 429), which
  does not affect users. Text is CC BY-SA 4.0; images carry their own licences,
  fetched via the Action API (`prop=imageinfo&iiprop=extmetadata`, `origin=*`)
  and shown with a link to the Commons file page.
- **OpenStreetMap tiles** `https://tile.openstreetmap.org/{z}/{x}/{y}.png`,
  © OpenStreetMap contributors (ODbL). Attribution is displayed; tiles are not
  bulk-prefetched and the service worker has no route for them, per the
  OSM tile usage policy.
