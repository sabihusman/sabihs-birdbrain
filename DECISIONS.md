# Decisions

Choices made while building, with alternatives and reasons. Newest at the bottom.

## 1. Model source: git history of BirdNET-Analyzer at tag v1.5.1

- **Decision:** take the official TF.js export of BirdNET V2.4 (acoustic + geo
  model, labels, sample clip) from tag `v1.5.1` of `birdnet-team/BirdNET-Analyzer`.
- **Alternatives:** Zenodo record 15050749 (current distribution), Google Drive
  zip (docs/models.rst), converting the TFLite/SavedModel myself.
- **Reason:** `github.com`/`api.github.com` were blocked by the session's network
  policy but `git clone` over HTTPS worked. The checkpoints were deleted from
  `main`, but v1.5.1 still contains the exact TF.js export the BirdNET team
  published, with `model.json` metadata showing the converter versions. No
  conversion step means no risk of a conversion bug. The files are committed
  to the repo (~78 MiB, largest file 4 MiB) because GitHub Pages serves them
  directly; Git LFS objects are not served by Pages.

## 2. Spectrogram front end re-implemented, "real part" semantics

- **Decision:** write `MelSpecLayerSimple` from scratch, computing the STFT in
  plain JavaScript with our own FFT, and reduce the complex STFT with its
  **real part** before the mel filterbank.
- **Alternatives:** copy the BirdNET demo's `main.js` layer (uses
  `tf.signal.stft` + `tf.cast`); use magnitude (`|X|`) instead of the real part.
- **Reason:** the demo file is under CC BY-NC-SA, incompatible with the app's
  MIT licence, so it was used as a reference only. `tf.cast(complex, 'float32')`
  in TF.js keeps the real part, so "real" is what the published export does.
  Empirical check in Node (CPU backend): on the bundled sample, real part gives
  Lesser Redpoll 0.94 / Common Redpoll 0.80; magnitude gives Clay-colored
  Sparrow 0.72 / Lesser Redpoll 0.58. On the official 2-minute example
  soundscape, real part gives Black-capped Chickadee 0.81, House Finch 0.64,
  Tufted Titmouse, Blue Jay, all in the file's known species list. The JS STFT
  also removes any dependency on backend FFT kernels (the WASM backend has
  none), so one code path works on WebGL, WASM and CPU.

## 3. Backend order: WebGL, then WASM, then CPU, all inside a Web Worker

- **Decision:** try WebGL first, fall back to WASM (SIMD when available) and
  finally plain CPU; a Settings option overrides the order (applies after
  reload). WebGPU is not included.
- **Alternatives:** WASM first (predictable), WebGPU first (fastest on new
  Safari/Chrome), main-thread inference.
- **Reason:** WebGL has the broadest support and best speed/compatibility
  ratio for this EfficientNet-style model. TF.js refuses to create an
  `OffscreenCanvas` on Safari (`IS_SAFARI` check in `canvas_util.js`) and then
  fails in a worker where there is no `document`, so the worker clears the
  `IS_SAFARI` flag and disables `WEBGL_FENCE_API_ENABLED` (the reason TF.js
  avoids it) before initialising. If that still fails on some iOS version the
  WASM fallback kicks in. WebGPU support in TF.js is still experimental and
  would add a fourth code path to test blind; it can be added later.

## 4. Week-of-year formula

- **Decision:** BirdNET "week" = `(month - 1) * 4 + min(4, ceil(day / 7.75))`,
  i.e. four slots per month (days 1-7, 8-15, 16-23, 24-31); `-1` when the
  seasonal filter is off.
- **Alternatives:** ISO week number scaled to 48; `min(4, ceil(day / 7))`.
- **Reason:** BirdNET-Analyzer documents weeks as "values in [1, 48] (4 weeks
  per month)" and the `birdnet` PyPI package validates 1..48, but neither
  publishes a date-to-week function. 7.75 (= 31/4) splits months evenly.
  I do not have a verified source for the exact split BirdNET's GUI uses.

## 5. Location filter is a hard filter with a default threshold of 0.03

- **Decision:** species whose geo-model score is below the threshold (default
  0.03, BirdNET-Analyzer's `sf_thresh`) are dropped from results when a
  location is known; the strongest dropped bird is still shown greyed out and
  labelled so the filter's effect is visible.
- **Alternative:** multiply acoustic confidence by the geo score (soft prior).
- **Reason:** matches BirdNET-Analyzer's species-list behaviour, which users
  of BirdNET expect; the greyed-out row keeps the behaviour honest.

## 6. Windowing: 3 s windows, default 1.5 s overlap, drop when busy

- **Decision:** default overlap 1.5 s (a new window every 1.5 s); windows that
  arrive while inference is running are skipped and counted, not queued.
- **Alternatives:** BirdNET-Analyzer's default of no overlap; queueing.
- **Reason:** overlap halves the chance a call straddles a boundary. Queueing
  would build unbounded latency on slow phones; skipping keeps results live and
  the skipped count is visible in the stats.

## 7. Short tails of recordings are zero-padded

- **Decision:** when analysing a file, a final segment shorter than 3 s but at
  least 1 s long is zero-padded; shorter tails are ignored.
- **Alternative:** BirdNET-Analyzer pads with noise.
- **Reason:** deterministic and simple; the model normalises each window, so
  padding with silence is benign.

## 8. Service worker: precache the shell, runtime-cache the model

- **Decision:** Workbox precaches the app shell (JS, CSS, HTML, icons, the
  AudioWorklet module, the three WASM binaries, `labels.json`). Model topology
  and weight shards are cached on first use with a cache-first runtime route.
  No route exists for map tiles, so they are never cached.
- **Alternative:** precache the model shards too.
- **Reason:** precaching would download the 78 MiB twice on first run (once by
  the app, once by the service worker install) and would hold up "offline
  ready". With runtime caching the first load populates the cache and the
  progress bar reflects the single real download. Labels are precached so the
  species browser works offline before any model download.
- **Follow-up found by the offline e2e test:** the very first page load is not
  controlled by the service worker (it has only just been installed), so model
  fetches on that load bypass the runtime route and the model would have been
  downloaded again on the second visit. The worker therefore reads and writes
  the same Cache API bucket (`birdnet-models-v2.4`) itself, cache-first, and
  the service worker is set to `clientsClaim`. The e2e test now verifies that
  after one online visit the app reloads offline with the model served from
  cache.

## 9. Storage: IndexedDB via `idb`, settings in localStorage

- **Decision:** recordings (WAV blobs), detections and the Wikipedia cache live
  in IndexedDB (`idb` wrapper); settings in localStorage.
- **Reason:** blobs need IndexedDB; settings are tiny and synchronous reads keep
  the UI simple. `navigator.storage.persist()` is requested from Settings and the
  result shown. **iOS caveat:** Safari may still delete a site's storage after
  seven days without use (ITP) or under storage pressure, even when
  `persist()` returned true; the app says so in Settings and Help, and offers
  WAV/CSV/GeoJSON export.

## 10. Species colours: OKLCH hue from a hash of the scientific name

- **Decision:** hue = FNV-1a hash of the scientific name spread with the golden
  angle; fixed lightness 0.64 and chroma 0.15 in OKLCH, converted to sRGB in
  code (so canvas and CSS agree). The name is always shown next to the colour.
- **Alternative:** curated palette of ~20 colours with session-local assignment.
- **Reason:** stable across sessions and devices with no state; mid lightness
  reads on both light and dark backgrounds (unit test checks relative
  luminance for every hue). With 6,522 species two can share a hue, which the
  always-visible name resolves.

## 11. "Why this ID" occlusion grid

- **Decision:** mask time-frequency regions of the 3 s window in an STFT domain
  (1024/256, mel-spaced frequency bands), resynthesise audio and re-run the
  model; default grid 6 x 4 (25 model passes), with 8 x 6 and 12 x 8 options.
- **Alternative:** gradient-based saliency (not available through the Layers
  API without a custom training graph); occluding the model's internal mel
  spectrogram (the model takes raw audio, so that would require surgery on the
  graph).
- **Reason:** occlusion is model-agnostic and honest. 25 passes take roughly
  10-20 s on a phone GPU, which is acceptable with a progress bar and cancel;
  finer grids are opt-in. Tradeoff: coarse cells cannot localise a short note.

## 12. No UI framework

- **Decision:** vanilla TypeScript with a tiny `el()` helper and hash routing.
- **Reason:** five screens and a handful of components; a framework would add
  bundle size and build complexity for little gain. Canvas drawing is imperative
  anyway.

## 13. Imported files are decoded by the browser, then stored as 48 kHz WAV

- **Decision:** use `OfflineAudioContext.decodeAudioData` (handles mp3/m4a/wav
  and resamples with a proper filter) and fall back to the in-house WAV decoder;
  store the result as 16-bit WAV so re-analysis and export are uniform.
- **Reason:** robust format support without bundling decoders.

## 14. Playwright runs on Chromium only

- **Decision:** the e2e test and README screenshots use the Chromium binary
  pre-installed on the VM (Playwright 1.56.1) with the iPhone 13 viewport.
- **Reason:** WebKit binaries are not installed and cannot be downloaded here;
  real iOS behaviour (microphone, wake lock, home-screen mode) must be checked
  on a device. The pinned `@playwright/test` version matches the VM's browsers.

## 15. Things that could not be verified from this VM

- Microphone capture, AudioWorklet timing, wake lock and standalone-mode
  permission prompts on a real iPhone.
- WebGL-in-worker on iOS Safari (see decision 3); the WASM fallback is tested
  in Chromium only.
- Wikipedia responses beyond the headers (the VM's egress was rate-limited),
  so disambiguation/not-found handling is implemented from the documented API
  shapes and the headers observed, not from a live run.

## 16. Back end: Better Auth for passwords and sessions, own email-code layer

- **Decision:** use Better Auth (email + password, bearer plugin, `node:sqlite`
  database) for users, hashing and sessions, but do not mount its HTTP handler.
  The app calls `auth.api.*` server-side and adds the second factor itself: the
  session token from the password step is parked in `login_challenge` and
  released only after the emailed 6-digit code is verified.
- **Alternatives:** Better Auth's `twoFactor` plugin (its OTP flow tracks the
  pending login with a cookie, which the cross-site, cookie-less iPhone client
  cannot carry); the `emailOTP` plugin (passwordless, not password + code).
- **Reason:** keeps the proven parts (scrypt hashing, session store) and the
  cross-site bearer flow the brief requires. Expired challenges revoke the
  session they guarded. Schema migrations run from the options object before
  the instance is created, otherwise Better Auth logs a schema mismatch.

## 17. Rate limits in the app are in-memory

- **Decision:** fixed-window counters in process memory (per IP, per email, per
  challenge) in addition to Nginx limits.
- **Alternative:** counters in SQLite.
- **Reason:** single container; a restart resets the counters, which is
  acceptable because Nginx keeps its own limit and the code challenge burns
  after 5 attempts regardless.

## 18. Imported clips are truncated to 60 s, not rejected

- **Decision:** keep the first 60 seconds and tell the user.
- **Alternative:** refuse files longer than 60 s.
- **Reason:** friendlier for field recordings; the cap is about on-device
  memory and time, which truncation satisfies.

## 19. Plus Codes via Google's `open-location-code` package

- **Decision:** full 10-character codes with a hand-written type declaration
  (the package ships no types).
- **Reason:** official implementation, Apache-2.0, no network, 14 m cells.

## 20. CSP without `'unsafe-inline'`

- **Decision:** `style-src 'self'`; the DOM helper sets styles via CSSOM, and
  Leaflet also uses CSSOM, so no inline style attributes exist in the shipped
  app. `script-src` needs `'wasm-unsafe-eval'` for the TF.js WASM backend.
- **Verification:** `scripts/csp-check.mts` serves the build with the exact
  `vercel.json` headers and exercises listen, demo, map, species, settings and
  import in Chromium; it fails on any `securitypolicyviolation`.

## 21. Image tag and deploy trigger

- **Decision:** the server pulls `ghcr.io/sabihusman/birdbrain-api:latest`; CI
  triggers the deploy through an SSH key whose forced command is the root-owned
  `/usr/local/sbin/birdbrain-deploy.sh` (no arguments; sudoers `""`).
- **Alternative:** pass an image digest to the deploy script.
- **Reason:** the forced command cannot take arguments by requirement, so the
  script pulls the tag; `sha-<commit>` tags are also pushed so `compose.yml`
  can be pinned by hand for a rollback. Recorded as a supply-chain gap in
  docs/SECURITY.md.

## 22. Server install findings (2026-10-19)

Made while applying `server/deploy/` to the live server, step by step with
Sabih's approval and a baseline check of the other sites after every reload.

- **No `http2` listen flag on the Birdbrain vhost.** nginx 1.24 sets HTTP/2
  per address:port, and the mba-vault catch-all (`default_server`) already
  enables it on the shared `:443` socket. The explicit flag only made
  `nginx -t` warn "protocol options redefined" for Sentinel's file. Verified
  on the scratch config and live: both hosts still negotiate HTTP/2 without it.
- **Root-owned `~birdbrain-deploy/.ssh` (0755) and `authorized_keys`
  (0644).** Alternative: user-owned 0700/0600. Reason: the deploy user cannot
  loosen its own forced-command restrictions; sshd `StrictModes` accepts root
  ownership. Tested from the PC with the private key while the deploy lock was
  held: `ssh … id` and a shell request both ran only the deploy script
  (exit 75, "another deploy is running"); a `-L` forward carried no traffic.
- **Volume ownership fixed in `setup.sh` step 8, not in the Dockerfile.** The
  image has no `/data` or `/backups`, so Docker created the named volumes
  `root:root 0755` and the uid-1000, read-only container could not write
  SQLite. Step 8 runs `compose create`, chowns both volumes from a throwaway
  `alpine` container, then `compose up -d`. Alternative: `mkdir` + `chown` in
  the Dockerfile, which is cleaner but would have rebuilt and re-tagged the
  pinned image mid-install. Follow-up: add it to the Dockerfile anyway.
- **`BIRDBRAIN_IMAGE_TAG=latest` after the merge.** Installed pinned to
  `sha-1cc01d4`; switched to `latest` once PR #2 was on `main` so CI deploys
  take effect. The CI deploy ran as a correct no-op while pinned, then a manual
  run recreated the container on `latest` with the data volume intact.
  Rollback: pin a `sha-<commit>` tag and run the deploy script.
- **Verified in Phase 4:** other sites' status codes unchanged throughout;
  `/health` 200 over TLS 1.2+ with HSTS/nosniff/no-referrer; TLS 1.1 refused;
  20 KB body → 413; burst of requests → 429; preflight allows only
  `https://sabihs-birdbrain.vercel.app` (other origins get no
  `access-control-allow-origin`); `/v1/ask` without or with a bogus token →
  401; port 8010 unreachable publicly; Vercel production serves the strict CSP
  with zero console violations; GitHub Pages still 200.
- **Not verified here:** a pending (non-admin) user receiving 403 on
  `/v1/ask`, Gmail delivery and Gemini answers with the real keys. Those need a
  real signup, which Sabih does from the live app. Also the ACME renewal path
  itself (the timer's first run logged "Skip renewal", as expected for a fresh
  certificate; the first real renewal is due around 2026-12-18).

## 23. GitHub Pages switched off (2026-10-19)

- **Decision:** remove `.github/workflows/deploy.yml` and unpublish the Pages
  site once Vercel production was verified; Vercel is the only front-end host.
  Dev and preview now serve at `/`; `VITE_BASE_PATH` stays as a generic
  override, and `ci.yml` is unchanged.
- **Alternative:** keep Pages as a permanent mirror at `/sabihs-birdbrain/`.
- **Reason:** two live copies with different base paths meant two service
  worker scopes, two model caches and a CSP that only one host enforced; the
  Wikipedia User-Agent and docs also pointed at the old URL. The model files
  stay in the repo (decision 1) because Vercel serves them the same way.

## 24. Microphone: ask for raw audio, then show what was applied

- **Decision:** `getUserMedia` asks for `echoCancellation: false`,
  `noiseSuppression: false`, `autoGainControl: false` (as before), and the
  engine now reads `MediaStreamTrack.getSettings()` on the opened track and
  classifies the answer (`src/audio/mic-constraints.ts`): all three reported
  `false` = "off"; any `true` = "partly on" / "on"; none of the three keys
  present = "not controllable". Settings › Microphone shows the headline and
  the per-key detail for the last session.
- **Browser support (MDN browser-compat-data 8.1.6, read from the package,
  not verified on a device):** `getSettings()` exists on Safari iOS since 11.
  The `echoCancellation` constraint is supported on Safari iOS (13.4 in
  `getSupportedConstraints`), **`noiseSuppression` and `autoGainControl` are
  not** (no Safari iOS version listed for the constraint, for
  `applyConstraints`, or for the settings key). Chrome for Android supports all
  three (since 53/67). Expectation on iPhone: the report reads "off" with
  "noise suppression and automatic gain not controllable", or "not
  controllable" if WebKit also omits `echoCancellation` from the settings.
  Whether iOS still applies its own voice processing to a web-page microphone
  regardless of the request cannot be determined from a web page; it must be
  judged by ear on a device.
- **Before this change:** the constraints were requested the same way but the
  applied settings were never read or shown.

## 25. 150 Hz low-cut on the analysis path only

- **Decision:** the engine has two AudioWorklet taps on the microphone: a raw
  tap (recording, waveform/spectrogram, conditions indicator) and an analysis
  tap behind a `BiquadFilterNode` (`type: 'highpass'`, `frequency: 150`,
  `Q: 1` dB, the node default) feeding the Windower. Imported, re-analysed,
  demo and "Why this ID" audio goes through the same node type in an
  `OfflineAudioContext` (`renderLowCut`), with a plain-JS biquad using the
  Web Audio coefficient formula as the fallback. Saved recordings and
  auto-save clips always come from the raw tap (a sample ring aligned by
  absolute offset) so they can be re-analysed later with other settings.
  Settings toggle `lowCut`, default on.
- **Alternative:** filter in the Worker before the mel layer. Rejected: the
  user asked for a Web Audio node, and a node keeps the filter out of the
  model code and identical for live and offline paths.
- **Reason for 150 Hz:** wind, handling and traffic rumble sit below it, and
  BirdNET's first mel spectrogram starts at 0 Hz (the second at 500 Hz), so
  rumble does reach the model.
  Very few bird sounds lie below 150 Hz; the exceptions are low booms and
  drumming (bitterns, some grouse, large owls), which is why it is a toggle
  rather than always on.
- **Caveat:** both taps run in the same render quanta but their messages
  can arrive in either order, so the engine holds a window until the raw ring
  has caught up. The alignment relies on both taps seeing the same sample
  count, which holds for one shared `AudioContext`; it is tested with fakes,
  not on a device.

## 26. Conditions indicator thresholds

- **Decision:** once per second of raw audio (`src/audio/conditions.ts`):
  "Too quiet" when RMS < -50 dBFS; otherwise "Windy" when at least 60 % of
  the spectral energy (Hann-windowed 2048-point FFT, bins up to 15 kHz) lies
  below 150 Hz; otherwise "Good". The level test comes first so faint rumble
  reads as "Too quiet". The label is text ("Conditions: Windy · guidance
  only") plus one line of advice, with the colour as a secondary cue, and it
  never stops or pauses listening.
- **Alternative:** calibrate thresholds per device from the first seconds.
  Rejected for now: phone microphones differ widely in gain and the numbers
  here are meant to be readable and adjustable, not exact. Expect to tune
  -50 dBFS once real iPhone levels are known.

## 27. Member features are gated from the cached session

- **Decision:** the species ID card, sighting history and species clips are
  unlocked when the session the `ApiClient` loads from localStorage has
  `status: 'approved'` (`src/app/access.ts`). No server call is made for the
  decision, so approved members keep the features offline. Signing out clears
  the cached session, which hides the features; IndexedDB is not touched, so
  the clips and detections are still there after the next sign-in.
- **Consequence:** the cached session carries the server's `expiresAt`
  (`SESSION_TTL_SECONDS`, default 24 h, extended on use by `updateAge`). An
  expired cached session counts as signed out, so a member who stays offline
  longer than the token lifetime loses the features until they sign in again.
  Raise `SESSION_TTL_SECONDS` on the server if that is too short.
- **Alternative:** a separate "member until" flag persisted on the device.
  Rejected: it would outlive a revoked or disabled account.
- **Collection is also gated:** clips are only cut and stored while a member is
  signed in (`controller.setClipsEnabled`), so free users do not accumulate
  ~1 MB WAVs they cannot play.

## 28. One raw clip per species, replace-if-higher, 10 s cap

- **Decision:** IndexedDB store `clips` (DB version 2) keyed by scientific
  name. A clip is at most 10 s of raw, unfiltered 16-bit WAV at 48 kHz, cut by
  `clipRange()` so it is centred on the detection window (or on the span of
  the species' windows in a recording when that fits in 10 s, else on the best
  window), shifted at the edges to keep its length. A new clip replaces the
  stored one only when its confidence is strictly higher.
- **Live listening:** the controller keeps a 24 s raw rolling buffer
  (`SampleRing`) and a pending entry per species; the clip is cut once 3.5 s of
  audio after the window has arrived, or with what exists when listening stops.
  A more confident detection of the same species replaces the pending entry.
- **Recordings and imports:** cut from the decoded (raw) recording after each
  analysis, one offer per species.
- **Reason for raw:** the clip is for listening and for later re-analysis, and
  the low-cut filter (#23) belongs to the analysis path only.

## 29. Heat map plugin: `leaflet.heat` 0.2.0, pinned

- **Decision:** `leaflet.heat` 0.2.0 (BSD-2-Clause, Vladimir Agafonkin; bundles
  `simpleheat`) with `@types/leaflet.heat` 0.2.5, pinned exactly. Pins
  (`leaflet.markercluster`) by default below 10 located sightings, heat above,
  with a toggle; both draw over the same single OSM tile layer that is never
  cached (#9 tile policy).
- **Honest caveat on "maintained":** no Leaflet heat-map plugin has had a
  release in years; `leaflet.heat`'s last release is from 2015 (the npm
  `time.modified` of 2022 is a metadata touch). It is the smallest and most
  widely used one, has no dependencies, and works unchanged with Leaflet 1.9.
  Alternatives checked: `heatmap.js` 2.0.5 (MIT, also dormant, larger). If the
  plugin ever breaks, a canvas heat layer is about 80 lines.
- **Privacy:** the heat map is built only from the user's own detections in
  IndexedDB and is a member feature; it reveals where someone walks, so it is
  never exported or sent anywhere (README › Privacy).

## 30. Front-end `Referrer-Policy: strict-origin-when-cross-origin` (tiles need a Referer)

- **Symptom:** map tiles answered `403 Access blocked` on the live site.
  OpenStreetMap's tile usage policy requires browser apps to send a valid
  `Referer`; `vercel.json` sent `Referrer-Policy: no-referrer` for every
  page, so tile requests carried none.
- **Decision:** `strict-origin-when-cross-origin` for the front end. Cross-
  origin requests (tiles, Wikipedia images and REST calls, the API) now carry
  the origin only, `https://sabihs-birdbrain.vercel.app/`, never a path or the
  hash route; same-origin requests carry the full URL, which is ours anyway.
  Nothing in a Birdbrain URL is secret (hash routes name species, not
  people), so the origin is all that leaks.
- **Checked:** `index.html` has no `<meta name="referrer">`; the Leaflet tile
  layer uses the default `referrerPolicy: false` (Leaflet 1.9.4 adds the
  attribute to tile images only when the option is set, per the option's
  source documentation), and `crossOrigin: true` does not affect the
  referrer. The API's Nginx `Referrer-Policy no-referrer` stays: it serves
  JSON only and loads nothing third-party.
- **Guard:** `tests/headers.test.ts` reads `vercel.json`, `index.html` and the
  map module and fails if any of them reintroduces `no-referrer`; the map
  e2e test checks that tile images carry no `referrerpolicy` attribute.
- **Not verified here:** the 403 disappearing on the live site (needs the
  Vercel deploy); the tiles loaded only in Chromium against the preview
  server, which sends no headers.

## 31. Default confidence threshold 60 %, migrated once from 25 %

- **Decision:** `DEFAULT_SETTINGS.threshold` is 0.6 (was 0.25) and the
  auto-save bar defaults to 0.6 as well. Stored settings carry a `version`;
  loading a store without one (or < 2) replaces a saved threshold that
  equals the old default with the new default and stamps version 2. Any
  other saved value is a user's choice and stays, and after the stamp a
  threshold of 25 % stays too.
- **Auto-save clamp:** `sanitize()` raises `autoSaveMinConfidence` to the
  detection threshold whenever it would be lower, because a clip is only
  saved for a detection; the Settings sliders re-read the store after each
  change so the clamped value is what they show.
- **Reason:** at 25 % BirdNET lists many weak candidates on a phone; 60 %
  matches what the sample clip and field use produced as reliable. The
  Listen screen's help line already says what lowering does.
- **Not verified:** field behaviour at 60 % on a phone; the e2e tests still
  detect the sample clip at the new default.

## 32. Live waveform and spectrogram auto-scale to the recent peak

- **Symptom:** after #22 (no automatic gain on the microphone) raw phone
  input peaks at roughly 0.01–0.06 of full scale. The waveform drew samples
  on a fixed ±1 axis into a 56 px canvas, so a 0.02 peak was 0.6 px: a flat
  line. The spectrogram mapped a fixed 0…−80 dBFS window, so the same input
  sat in the dark purple end of the colour map. The data path was intact
  (the level bar and the conditions indicator read the same raw tap); the
  scale was the bug, case (b).
- **Decision:** `src/ui/viz/autoscale.ts`. The waveform follows the loudest
  sample in its 3 s ring with a fast-attack, slow-release follower and
  applies a gain capped at ×100, rounded to readable steps (×1, ×2…×9, ×10,
  ×15…), shown on the canvas and in the caption. The spectrogram's colour
  window is 60 dB wide and its top follows the loudest bin of recent columns
  (instant attack, 0.25 dB per column release, never below −70 dBFS so
  digital silence is not blown up into a bright noise floor); the window is
  printed bottom right. Static spectrograms of recordings use one window set
  from the clip's loudest bin.
- **Alternative:** remove the panel. Rejected: the scaled trace is useful
  (the gain number itself tells how quiet the mic is) and the test suite now
  proves a −40 dBFS sine fills more than 80 % of the canvas height.
- **Not verified:** on a phone; the thresholds (×100 cap, 60 dB span,
  −70 dBFS top floor) are first guesses for real microphone levels.

## 33. `/data` and `/backups` are created in the image, owned by uid 1000

- **Decision:** the Dockerfile now runs `mkdir -p /data /backups && chown
  node:node /data /backups` (the `node` user in the official image is uid
  1000, the uid `compose.yml` runs as). Docker populates a *new* named volume
  from the image directory it is mounted over, ownership included, so fresh
  volumes are writable without any host-side step.
- **Kept:** `setup.sh` step 8 still chowns both volumes from a throwaway
  `alpine` container. Existing volumes created by images without these
  directories stay `root:root` until something chowns them, and the step is a
  harmless no-op otherwise. This closes the follow-up noted in #22.
- **Not verified here:** the live server's volumes already exist and were
  chowned by step 8; the image change only matters for a `--purge` reinstall
  or a new host. The CI image build is the check that the layer is valid.

## 34. Certificate-renewal failure alert through the app's mailer

- **Decision:** `lego-renew-birdbrain.service` gets `OnFailure=birdbrain-renew-alert.service`
  through a drop-in (`lego-renew-birdbrain.service.d/onfailure.conf`), not by
  editing the unit, so the unit file stays an exact copy of Sentinel's pattern
  and `setup.sh` step 5's diff stays clean. The alert unit runs a root-owned
  script that composes the failure report (result, exit code, certificate
  expiry, last 40 journal lines) and mails `ADMIN_EMAIL` via
  `docker compose run --rm --no-deps -T api node dist/alert-mail.js`, a small
  CLI in the image that reuses `createSmtpMailer`. The SMTP app password
  therefore never leaves `/opt/birdbrain/.env`.
- **Alternatives:** `mail`/`sendmail` on the host (needs an MTA or the Gmail
  password in a second place); `docker exec` into the running API container
  (fails exactly when the API is down, while `compose run` only needs the
  image). Rejected for those reasons.
- **Behaviour:** the timer keeps running daily, so a persistent failure mails
  once a day; Let's Encrypt's 90-day lifetime and lego's 30-day renewal
  window leave time to act. The script also logs to the journal, so a mail
  that cannot be sent is still visible.
- **Not verified:** nothing ran on the server from this session; step 9 and
  `rollback.sh --only-alert` are to be applied from the PC with approval.
  `MONITOR_*` variables need systemd ≥ 251 (Ubuntu 22.04 has 249: the mail
  then says "unknown" for result and exit code, the journal lines still tell).

## 35. Sightings: consecutive detections of a species are one event

- **Decision:** a new IndexedDB store `sightings` (DB version 3) holds one
  record per run of detections of a species: `firstTime`, `lastTime`,
  `peakConfidence`, `hits` (windows merged), and the position, recording and
  offset of the peak window (or the first located window when the peak has
  none). A detection joins the most recent sighting of the same species and
  stream when it falls within `sightingGapSeconds` (setting, default 60) of
  it; otherwise it opens a new one. Streams: all live listening is one stream
  (sightings may span a stop/start), each recording or import is its own, so
  re-analysing a file never merges into live history. Per-window detections
  stay stored with a `sightingId`, for the recording timeline and "Why this
  ID".
- **Consumers:** the Map tab, the species page summary, the ID card, the
  sighting history list, the heat map (one point per sighting, weighted by
  peak confidence) and the CSV/GeoJSON exports (one row per sighting; the
  file names changed from `detections` to `sightings`, with `first_time_iso`,
  `last_time_iso`, `peak_confidence` and `hits` columns). Clips keep their
  replace-if-higher rule per species.
- **Migration:** the version-3 upgrade groups the existing detections with
  the 60 s default inside the upgrade transaction and links them, once.
  Changing the gap setting later affects new detections only.
- **Not verified:** on a phone; the migration is tested with
  `fake-indexeddb` from a hand-built version-2 database.

## 36. Species tab lists local species by default

- **Decision:** "local" means the existing BirdNET geo model scores the
  species at or above the range threshold (`geoThreshold`, the Settings
  slider) at the user's position in **any** of the 48 weeks. The worker runs
  the geo model once for all 48 weeks in a batch of 48 rows (one week per
  row at the same position; falls back to 48 single predictions if the graph
  refuses the batch) and keeps only the per-species maximum, so the threshold
  can change without recomputing. The result is cached in localStorage
  (`birdbrain.localSpecies.v1`, values rounded to three decimals) and
  recomputed only when the position moves more than 25 km (haversine).
- **UI:** count line "312 local species · 6,511 total", a "Show all
  species" toggle (setting `speciesShowAll`, default off), search over the
  shown list. With no position (filter off, denied, or not yet known) the
  tab shows everything with one line saying why; while the list is being
  computed it shows everything too. Listen's identification path is
  untouched (it still uses the current week via `set-geo`).
- **Not verified:** the batch prediction on the real TF.js geo graph in a
  browser (the fallback covers a refused batch); the 25 km radius is a
  guess at "same area" for a bird list.

## 37. AI context: relevant Wikipedia article sections, cached, cited

- **Endpoint:** the MediaWiki Action API, TextExtracts module:
  `api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=…&format=json&formatversion=2`.
  Without `exchars`, `exsentences` or `exintro` it returns the whole page as
  plain text with `== Heading ==` markers; `exlimit` only limits multi-page
  requests. Verified against the Extension:TextExtracts documentation on
  mediawiki.org on 2026-10-19 (en.wikipedia.org itself rate-limited this
  environment, so the test fixture is hand-written in that format).
- **Selection:** the lead plus sections whose heading starts with
  description, identification, vocalisation/voice/song/call,
  distribution/range/habitat, behaviour/ecology/breeding/nesting,
  diet/feeding/food, status/conservation/threats/population, taxonomy.
  References, external links, culture and similar are dropped. Sub-headings
  stay inside their parent as "Name:" lines. Caps: 2,500 characters per
  section, 12,000 in total.
- **Cache:** SQLite table `wiki_article_cache`, keyed by scientific name,
  seven days; the summary endpoint remains the fallback (`context:
  "summary"` in the response) when the article is unavailable.
- **Citations:** the prompt labels each section `[Section: Name]`; the
  instruction asks for `[Name]` after each sentence; the server returns
  `citations: [{section, url}]` with the section anchor links it built, and
  the client shows "Sections cited: …". Unknown names are left as text.
- **Defences kept:** fence neutralisation and control stripping on every
  section and on the question, marker-based system-prompt leak rejection,
  plain-text output, caps and rate limits (DECISIONS #8 findings A1–A13).
- **Not verified:** a live TextExtracts response for a bird page (fixture
  only); how well Gemini follows the citation format.

## 38. Admin is told about new sign-ups, at most once per 10 minutes

- **Decision:** when a pending account verifies its e-mail code for the
  first time, the API mails `ADMIN_EMAIL` "New Birdbrain sign-up:
  name@example.com is waiting for approval" with the admin page link
  (`<first allowed origin>/#/admin`). Nothing else about the user goes into
  the mail. The admin's own account (approved at creation) and repeat logins
  never trigger it.
- **Rate limit:** `SignupNotifier` keeps an in-memory window of 10 minutes:
  the first sign-up of a quiet period is mailed at once; sign-ups inside the
  window are held and sent as one summary ("6 new Birdbrain sign-ups are
  waiting for approval", addresses listed) when the window closes, by a
  timer or by the next sign-up after it. A spam burst therefore costs at
  most one mail per 10 minutes. The state is per process (a restart may
  send one extra mail), which matches the in-memory rate limiters (#17).
- **Failure:** a mailer error is logged and never surfaces to the
  signing-up user; approval is still possible from the admin page.

## 39. Theme system per docs/DESIGN_GUIDE.md (dark by default)

- **Decision:** two themes from the guide, "Forest Night" (dark, the default
  whatever the phone prefers) and "Field Guide, cream" (light), as CSS tokens
  on `:root` and `:root[data-theme="light"]` (`src/styles.css`) mirrored in
  `src/theme/tokens.ts` for canvases and tests. A sun/moon button in the
  header (44 px, `aria-label`, focus ring) toggles and stores the choice in
  `localStorage` (`birdbrain.theme.v1`, try/catch, falls back to dark). An
  inline script in `<head>` sets `data-theme` before first paint; its SHA-256
  is allow-listed in `vercel.json`'s `script-src` so the CSP stays without
  `'unsafe-inline'`, and `tests/headers.test.ts` fails if the script and the
  hash drift apart.
- **Token changes for WCAG AA** (the guide allows changing tokens, never
  species colours): light `--warn` #A8661B → #8F5614 (4.26:1 → 5.4:1 as text
  on the card) and light `--muted` #6A7066 → #5F665C (4.33:1 → 5.2:1 on the
  page). All other pairs passed. Species dots: on the dark card every sampled
  colour is ≥ 3:1, on the cream card most are not, so every dot now carries a
  1 px ring in `--muted` (≥ 3:1 on both cards) instead of changing the colour.
  `tests/theme-contrast.test.ts` keeps these checks.
- **Canvases and status colours** read tokens: waveform (`--wave` = accent,
  badge `--muted`), spectrogram overlay (`--viz-fg`), timeline axis
  (`--muted`), heat-map gradient (accent → warn → error), conditions bar,
  level meter (`--live`), status pill dot (ok/error), Leaflet controls and
  attribution. The spectrogram image itself keeps a near-black field in both
  themes because the colour map needs it; tiles stay as OSM serves them.
- **Foundations:** 8 px spacing scale, 20 px card radius, 14 px controls,
  one type scale (12–32 px), `prefers-reduced-motion` disables transitions
  and the meter animation, 3 px `--focus` ring with 3 px offset.
- **Not verified:** on a phone; screenshots come from Chromium with a fake
  microphone. The headless "mic blocked" shot shows "No microphone was found"
  (no device in the container) rather than a denied permission.

## 40. Listen layouts and states per docs/DESIGN_GUIDE.md §5–7

- **Decision:** the Listen view is one set of pieces (status row with icon
  and words, 140 px mic button, listening panel with timer, "screen stays
  on", level meter, conditions line and full-width Stop, result cards,
  collapsed "How it works" and "Recent sightings" folds, context chips)
  arranged by `listenLayout` (Settings → Listen layout, remembered on the
  device): **Consolidated** (default; panel on top, cards below, newest
  first), **Bottom dock** (cards fill the screen; a dock above the tabs shows
  "● Listening · 02:14" + Stop, or "Start listening" when ready) and **Focus
  mode** (one large card for the latest bird with the conditions, large
  Stop, "▲ N more birds · swipe up" that also opens by tap and closes with
  Escape).
- **States** (`src/ui/status.ts`): loading (progress + the 78 MB note),
  ready, listening, paused (resume button; the controller exposes
  `resumeListening()`), mic blocked (iPhone steps, Try again, import link),
  error, offline. The header pill shows the same text with a tone dot; both
  always carry words. The controller keeps the last start error so the view
  can tell "denied" from "no microphone" or "busy".
- **Result cards:** Wikipedia thumbnail from the cached summary (one lookup
  per species per session, sage tile with a bird outline until it arrives
  or when there is none), colour dot + common name, scientific name,
  confidence, "just now / 0:40 ago"; members get the saved-clip button; the
  whole card links to the species page. One card per species, refreshed by
  the newest detection. Candidates between 10 % and the minimum are counted
  behind "N more sounds below your minimum · show".
- **Moved:** the confidence slider left the Listen screen for Settings (the
  chip "Min. 60 %" links there); the waveform, spectrogram, pipeline and
  timeline live inside "How it works", which stays open for the session once
  opened; stats (windows, inference time) are no longer shown on Listen.
- **Accessibility:** 44 px targets, buttons everywhere (keyboard), `aria-live`
  status, reduced motion stops the live dot, nothing plays until tapped.
- **Tests:** Playwright now launches Chromium with a fake microphone, so each
  layout is exercised through Ready → sample clip cards → Listening → Stop,
  plus the blocked-microphone state; unit tests cover the state mapping and
  relative times. Screenshots of all three layouts in both themes (Ready,
  results, Listening, Mic blocked) are in `docs/screenshots/`.
- **Microphone help by browser:** `src/ui/mic-help.ts` reads the user agent
  (CriOS, FxiOS, EdgiOS; Safari otherwise on iPhone) and shows that browser's
  path: Chrome "iPhone Settings › Apps › Chrome › Microphone, then reload and
  tap Allow", Safari its own steps (Settings → Safari → Microphone, Settings ›
  Apps › Safari on iOS 18, or the aA menu), and a generic "Settings › Apps ›
  [your browser] › Microphone" for anything else on iPhone. The engine's
  denied message is one short sentence and the status line stays empty, so
  the explanation appears once (the iPhone test showed it twice).
- **Updates:** the service worker runs with `registerType: 'prompt'`; a new
  version shows a "New version available — tap to update" banner at the top.
  Nothing reloads on its own, and a tap while listening only changes the
  banner to "Stop listening first", so a session is never interrupted.
- **Not verified:** on a phone (swipe, safe areas with the dock, real
  microphone states); the "paused" state needs a real backgrounding.


## 41. Species ticks: on-device "spotted" marks and the "Spotted by me" chip

- **Decision:** on the Species tab every species with at least one sighting
  on this device shows a tick (`✓`, accent colour, a 48 px button beside the
  chip with the words "spotted by you" in its label). Tapping the tick opens
  that species' ID card for members (the species page, scrolled to and
  focused on the card: the card is where the ID card lives today, and tapping
  it still opens the sighting history) and, for everyone else, shows the
  same one-line "Sign in to unlock the species ID card." note under the row
  (`lockedNoteEl`, split out of `member-gate.ts` so both places render it
  the same way). A pressable "✓ Spotted by me · N" chip above the list keeps
  only spotted species; the choice is remembered on the device
  (`speciesSpottedOnly`).
- **Where the set comes from:** `listSightedSpecies()` walks the unique keys
  of the sightings store's `by-scientific` index (`openKeyCursor(null,
  'nextunique')`), so no sighting rows are loaded however many there are.
  `src/species/spotted.ts` turns that into a `Set` and holds the pure filter;
  the view rebuilds the set on `detections-changed` (new detections, deleted
  recordings, "clear all data") and re-renders on session changes. Nothing is
  fetched: the ticks are decided from IndexedDB and the cached session only.
- **Scope of the chip:** while it is on, the local / "Show all species" scope
  is bypassed and the line reads "N species spotted by you · M total" with a
  note saying so. A bird you heard on a trip is still one you spotted; hiding
  it because it is not expected at home would make the list lie.
- **Alternatives:** a tick inside the chip link (`<a>`) would nest a button in
  a link, which is invalid and would make the chip tap ambiguous; a separate
  "my species" route would duplicate the list, search and local toggle; a
  persisted "spotted" flag on the species would drift from the sightings
  when recordings are deleted. Counting per species (`by-scientific` count)
  was not needed: the tick is binary and the species page has the numbers.
- **Tests:** `tests/spotted.test.ts` (fake-indexeddb: unique keys across
  repeated and separate sightings; the filter on/off, count, empty names).
  Playwright: the free-user import test checks the tick, the chip narrowing
  the list to ticked rows only, the count line and the inline sign-in note;
  the member test opens the ID card from the tick and checks it is focused.
- **Not verified:** on a phone; the tick row beside a long name at 320 px is
  not covered by the width test, which runs with no sightings (the CSS keeps
  the row from wrapping: the chip shrinks, the 48 px tick does not).

## 42. ID clips: 10 s context, identifying windows, spectrogram and tap-to-run "Why this ID"

- **Decision:** the per-species ID clip (#28) keeps its 10 s cap and its
  replace-if-higher rule, and now records *which* 3 s analysis windows
  triggered the ID: `ClipRecord.windows`, a list of `{ offsetSec, confidence }`
  relative to the clip start (DB version 4). Live, the controller remembers
  every window that detected the species while it is still inside the 24 s
  raw ring and stores the ones that fall in the clip (`windowsInClip`); for
  recordings and imports the per-window detections give the same list. A
  window cut at a clip edge keeps its true offset (it may be slightly
  negative) and is clamped when drawn. The surrounding audio is kept on
  purpose: other birds may be audible, and the user should hear the context
  the model heard.
- **Card:** the species ID card draws a spectrogram of the clip from the
  stored samples with our own FFT (`computeStaticSpectrogram`, shared with the
  recording view and DOM-free so the frames, outlines and cursor are
  unit-tested), outlines each identifying window in the species colour with
  its confidence as the label, shows a playback cursor (tap the spectrogram
  to seek) and a line listing the windows. "Why this ID" is a button: it runs
  the existing occlusion job on the most confident identifying window and
  shades the heat map over that window. It is 25–97 model passes, so it never
  runs on its own (as in the recording view).
- **Wording, in the card and here:** BirdNET marks *when* a species is heard,
  not which of the overlapping sounds it is. An outlined window means the
  model's confidence for that species crossed the threshold in those 3 s; the
  sound it reacted to may sit under another bird, wind or a voice. The
  occlusion heat map is the honest way to narrow it down, and it is still an
  approximation.
- **Migration:** version 4 adds no store; clips saved before it have no
  `windows` and are read as "unknown windows" (`clipWindows()` returns null):
  the card says the windows were not recorded, draws no outlines and runs
  "Why this ID" on the clip centre (live clips were always centred on their
  window). A later, more confident detection replaces such a clip the normal
  way. Tested with `fake-indexeddb` from a hand-built version-3 database.
- **Setting renamed:** the older option that saves each detection's 3 s
  window into Recordings is now "Auto-save 3-second detection windows as
  recordings" (hint: separate from the species ID clip), and those
  recordings are named "Detection window: <species>" instead of "Auto clip".
  The storage keys (`autoSaveClips`, `autoSaveMinConfidence`, source
  `'autoclip'`) are unchanged: nothing to migrate.
- **Not verified:** on a phone; the playback cursor follows
  `audio.currentTime` in a `requestAnimationFrame` loop, whose timing against
  the sound on iOS Safari has not been checked. Playwright exercises the card
  with the bundled sample (one window, the occlusion run) in Chromium.

## 43. `/v1/ask` reads Gemini's finish reason; no half sentences

- **Problem:** live answers ended mid-sentence ("…though it notes that the").
  The call asked for 400 output tokens and the model's own thinking counts
  against the same allowance on thinking models, so the visible answer was
  cut without any sign of it.
- **Decision:** `createGeminiModel` sends `maxOutputTokens: 700` (room for 2–4
  short paragraphs with citations) and `thinkingConfig.thinkingLevel: LOW`
  (`ThinkingConfig.thinkingLevel` / `ThinkingLevel.LOW` in `@google/genai`
  2.30). The Gemini API "Thinking" page lists `gemini-3.8-flash` with levels
  low, medium and high (default medium); `thinking_budget` is kept only for
  backward compatibility and cannot be combined with `thinking_level` (400),
  so the legacy field is not sent. It reads
  `candidates[0].finishReason`; on `MAX_TOKENS` it retries once with 1400,
  and if that is cut too it returns the complete sentences (citations kept)
  followed by "(answer cut short)". The system instruction already asked for
  at most 120 words. Each call logs one line, `[ask] attempt= limit= finish=
  prompt_tokens= answer_tokens= thinking_tokens= total_tokens=`, never the
  question or the answer.
- **Alternatives:** streaming (more code for the same result); raising the
  limit alone (hides the cause); asking the model to "finish the sentence"
  (another call, same risk).
- **Tests:** `server/test/ask-truncation.test.ts` with `FakeGemini` returning
  `finishReason: 'MAX_TOKENS'` once and twice.
- **Not verified:** a live call with the level set (a rejected value surfaces
  through the existing 502 path; adjust `ANSWER_THINKING_LEVEL` in
  `server/src/ask.ts`).

## 44. Friends: species-only sharing with explicit consent

- **Decision:** members can set a display name (`POST /v1/me/name`, trimmed,
  1–40 characters, no control or format characters), add friends by email,
  accept or decline invites and remove friends, and, only after turning on
  "Share my species list with friends", let accepted friends see which birds
  they have spotted. The Species tab then shows "Spotted by Alex, Sam" under
  a chip (next to the user's own tick from #41 when both apply), a "Spotted
  by friends" filter chip, and on each species page a "Spotted by" card with
  one row per person, "You" included, each with the day of their most recent
  sighting, newest first. The user's own row opens the ID card; friends'
  rows are not tappable. Friends' data is fetched by the client
  (`GET /v1/friends/species`), kept in memory and `sessionStorage` per user
  id, refreshed when the tab opens and the device is online, and dropped on
  sign-out.
- **What is shared, exactly:** per species the scientific name and the local
  calendar day (`YYYY-MM-DD`) of the most recent sighting. The upload
  (`POST /v1/me/species`) is always the full current set, capped at 2,000
  species; the server validates every name against `labels.json`
  (`unknown_species`), every day as a real calendar day, refuses duplicates
  and any extra field (strict schema), and replaces the stored rows in one
  transaction. The client builds the list from the sightings store
  (`buildSharedSpeciesList`: one entry per species, newest first) and uploads
  it debounced 5 s after `detections-changed`, on turning sharing on, on
  sign-in and when the connection returns. The consent text next to the
  switch reads: "Friends will see which birds you've spotted and the date you
  last spotted each one. Nothing else: no times, no places, no recordings, no
  counts. Turning this off removes the list from the server at once."
- **What is NOT shared:** times of day, positions, accuracy, counts of
  sightings or windows, confidence, clips or recordings, the history of
  earlier dates, species never spotted, the email address (friends see the
  display name; the mail to an invitee names the inviter by display name
  only and never carries any address). Nothing is uploaded while signed out,
  pending or with sharing off, and the consent flag is a `localStorage` key
  per user id, so it never follows the session to another account.
- **Invites:** `POST /v1/friends/invite` always answers
  `{ ok: true, message: 'Invite sent' }`; a mail goes out, and a row is
  stored, only when an approved account with that address exists, is not
  the caller, is not already a friend and has no open (pending or declined,
  unexpired) invite with the caller. The only other answer is 429
  `rate_limited` when the caller is past their own cap (10 per UTC day in
  `invite_usage`, counting every attempt alike, so the budget reveals
  nothing). Invites expire after 30 days; a declined one stays until then so
  the same person cannot re-invite daily. The invitee sees pending invites in
  the Account card (`GET /v1/friends`) and acts there; the mail says only
  "<Name> invited you ... open the Account card on the Settings tab". There
  is no outgoing-invites list, because it would reveal which addresses exist.
- **Deletion:** `POST /v1/me/delete` (session, strict empty body) runs one
  SQLite transaction over `shared_species`, `friendship`, `friend_invite`,
  `invite_usage`, the user's `ask_usage` scope, `login_challenge`, `session`,
  `account` and `user`. Better Auth 1.7 does have `auth.api.deleteUser`
  behind `user.deleteUser.enabled`, but it demands a fresh session (default
  `freshAge` 24 h) or the password and would not touch the app's own tables,
  so the direct transaction is simpler and complete. The admin account is
  refused (`admin_account`): it is the only one that can approve people.
  The Account card confirms inline (no pop-up); the client drops the local
  session either way. Recordings and detections on the device are untouched.
- **Gating:** every friend endpoint needs an approved member (401 without a
  session, 403 `not_approved` otherwise). A friend who is disabled or
  rejected disappears from lists and species answers at once (the join
  filters on `status = 'approved'`), without deleting their rows. Remove is
  idempotent (200 for strangers and unknown ids) so ids cannot be probed;
  accept/decline answer 404 alike for foreign, unknown and expired ids.
- **Tables:** `friend_invite` (id, from, to, status pending/declined,
  created, expires), `friendship` (ordered pair, since), `shared_species`
  (user, scientific, last_seen), `invite_usage` (day, user, count). No new
  environment variables.
- **Alternatives:** sharing full sightings with positions (rejected: the
  heat map is the most sensitive data the app holds, see #29); server-side
  invite tokens in the mail link (rejected: a link that logs you in is a
  phishing pattern, and the in-app list needs no token); push notifications
  (out of scope for this change); storing the consent in Settings (rejected:
  settings are per device, not per account, and a shared phone would leak
  the switch between accounts); a DELETE method (rejected to keep the CORS
  method list unchanged).
- **Tests:** `server/test/friends.test.ts` (name validation, invite
  sent/not-sent cases returning the same body, cap and reset, accept,
  decline, expiry, remove, upload replace/clear, validation, body limit,
  deletion) and `server/test/adversarial-friends.test.ts` (who can read a
  list: stranger, pending invitee, declined invitee, removed friend, signed
  out, disabled; a friend sees only display name and (sci, lastSeen) pairs;
  byte-identical invite answers; invite-id and remove probing; writing for
  someone else; header smuggling in names). Front end: `tests/sharing.test.ts`
  (what leaves the device, debounce, off/signed-out/pending/offline, per-user
  consent) and `tests/friends.test.ts` (index, cache per user, offline copy,
  sign-out), plus the API-client paths.
- **Not verified:** the whole flow against the live server and Gmail (the
  fake mailer stands in); the Species tab with real friends' data on a
  phone; the Account card at 320 px with long display names (the width test
  runs signed out).

## 45. Listen layout picker: preview tiles instead of a dropdown

- **Decision:** Settings → Listen layout is a row of three preview tiles
  (Consolidated, Bottom dock, Focus) instead of a `<select>` with a helper
  sentence. Each tile (`src/ui/components/layout-picker.ts`) is a button with
  a 52×73 phone wireframe (inline SVG, coloured through CSS classes and the
  theme tokens `--muted`, `--accent`, `--surface-2`, `--card`, so it works in
  both themes without style attributes under the strict CSP) and the layout
  name. A tap switches immediately through `settings.update({ listenLayout })`
  and the store change is mirrored back into the tiles.
- **Selected state:** 3 px accent border (2 px border plus a 1 px ring, so
  nothing shifts) and a check badge on the wireframe; never colour alone.
- **Accessibility:** `role="radiogroup"` / `role="radio"` with
  `aria-checked`; roving tabindex (selected tile 0, others −1); Left/Right
  and Up/Down move focus and selection with wrap-around, Home/End jump,
  Space/Enter select (native button activation); 3 px `--focus` ring; tiles
  are at least 44 px on both sides (about 102×119 px at 375 px).
- **Height budget:** the card must stay within 1.5× the dropdown card it
  replaced. Measured on main (efc0a2a) at a 375 px viewport the old card was
  210.59 px (h2 + 44 px select + a two-line hint); the picker card is
  183.4 px (tiles 98×113 px). `e2e/app.spec.ts` records that baseline as a
  constant and asserts the new card ≤ 1.5× it. At 320 px the test asserts
  the Settings view and every tile stay inside the viewport (tiles 79 px
  wide; "Consolidated" carries a soft hyphen, `hyphens: manual`, so it breaks
  cleanly there instead of mid-word). The check is on `main.view`, not the
  document root, because the sticky header's status pill ("Model ready ·
  wasm") alone exceeds 320 px by about 5 px once the model has loaded, a
  pre-existing header issue outside this change.
- **Removed:** the dropdown, its helper text ("Same components and states in
  every layout…"); the layout descriptions now live in each tile's
  `aria-label` and in DESIGN_GUIDE.md §6.
- **Not verified:** on a phone or with VoiceOver; checked in Chromium with
  Playwright and in both theme screenshots (`docs/screenshots/settings-*.png`).

## 46. Sighting card: title, map preview, confidence text, About this bird, Ask box

- **What the user saw:** the recording detail opened from Recordings carried
  the recording's stored name as its title: `Auto clip: <bird>` for
  auto-saved clips (`controller.persistDetections`), `Recording <date>` for
  mic recordings, the file name for imports. There was no "Audio clip" string
  in the code; the auto-clip name is what was being read as one.
- **Title:** the top detection's common name with the scientific name in
  italics beneath (`recording-title`, `recording-sci`); "Recording" when
  nothing is detected. The recording's own name, date, length and size move
  to the meta line. The title comes from the stored summary at once and from
  the per-window results after each analysis.
- **Location:** a 160 px `mapPreview` (`src/ui/components/map-preview.ts`,
  `createPreviewMap` in `src/ui/views/map.ts`) above the coordinates with one
  `L.circleMarker` dot in the species colour (accent until a species is
  known). Every Leaflet handler is off and there is no zoom control until the
  "Tap to explore" cover button is tapped; Leaflet 1.9 has no `tap` option any
  more (the handler was removed in 1.8), so touch is covered by `dragging`
  and `touchZoom`. The OSM attribution stays. Offline, a muted placeholder
  stands in and the map is built on the `online` event. `locationBlock` keeps
  coordinates + Copy + "Open in Google Maps" and folds the Plus Code into a
  `<details>` "More location details" with the line "Google's short code for
  this spot; works in Google Maps." The species ID card uses the same two
  pieces in the same order, so the two cards match; `createMiniMap` remains
  for the free user's multi-sighting map on the species page.
- **Confidence:** the per-species timeline canvas under the spectrogram is
  gone from this card (`TimelineView` still serves "How it works" on
  Listen). In its place: "Confidence 96% · your minimum 60%" (threshold from
  settings) and, when the top species matched several 3 s windows, one line
  per window in time order, "0:02–0:05 · 96%" (`src/ui/confidence-text.ts`,
  unit-tested). The per-species chips with "▶ best at" stay in Detections.
- **About this bird:** `src/ui/components/about-bird.ts` renders the summary
  (text, thumbnail with Commons attribution, article link; the same markup
  the species page had) plus collapsed Description, Song and calls, Habitat
  and Diet sections from the full article. `src/species/wiki-sections.ts`
  mirrors the server's TextExtracts request (#37) with `origin=*` added for
  the browser:
  `api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=…&format=json&formatversion=2&origin=*`
  (parameters checked against `action=help&modules=query+extracts` on
  mediawiki.org, 2026-10-19). Headings are split at every level, so
  "Vocalisations" is found under "Description"; the first heading matching
  each kind wins (description/identification/appearance; vocalisation/voice/
  song/call/sound; distribution and habitat/habitat/distribution/range; diet/
  feeding/food/foraging); each is cut to 600 characters at a sentence end
  with a link to the section. Cached in the existing IndexedDB `wiki` store
  under `wiki-sections:en:<scientific>`, so no DB version bump (another open
  PR bumps it for clips). The species page now uses the same component.
- **Ask:** `askBox` (previously mounted only on the species page,
  `src/ui/views/species.ts`) is mounted on the card for the top species.
  Its own gating stays: approved members get the form; signed-out and
  pending users see a "Sign in to ask" line (`ask-locked`). Answers come from
  the full article with section citations (#37); the box itself is
  unchanged.
- **Tests:** unit tests for the section parser, picker, truncation and the
  cached fetcher (`tests/wiki-sections.test.ts`, hand-written fixture in
  `tests/fixtures/`, as en.wikipedia.org rate-limits this environment) and
  the confidence text; the import e2e test now sets a manual position and
  checks the title, confidence line, map preview, folded Plus Code, About and
  "Sign in to ask"; the member test checks the Ask form on the card.
  Screenshots: `scripts/sighting-card-screenshots.ts` →
  `docs/screenshots/sighting-card-{dark,light}-{signed-in,signed-out}.png`.
  - **Not verified:** a live TextExtracts response in the browser (429 here;
  the fixture follows the documented format and the server's parser) and the
  map cover on a real touch screen.

## 47. `/v1/ask` sources: NatureServe Explorer and eBird beside Wikipedia

- **Decision:** the answer is built from up to three fetched sources, each
  with one role stated in the system instruction: Wikipedia for the biology,
  NatureServe Explorer for the conservation status (global rank and the
  S-rank for the asker's state/province), eBird for recent sightings in that
  state/province and, for nearby questions, within 50 km of a rounded point.
  The server fetches everything; Gemini has no tools. Every fact must carry
  its source as a citation (`[Wikipedia – Diet]`, `[NatureServe Explorer –
  Conservation status]`, `[eBird – Recent sightings]`, `[eBird – Recent
  sightings nearby]`); when sources disagree the model is told to give both
  and say "sources differ"; it must not invent counts, dates, places or
  ranks and must say when eBird lists no reports.
- **What the app sends (decided on the device, `src/geo/region.ts`):** the
  species, the question, `region` (one of `US-IA`, `US-IL`, `US-WA`,
  `CA-AB`, `CA-ON`, or `none`) and, only when the question reads as a nearby
  one (near, nearby, around here, close by, in my area, local, this county…)
  and location is on, `near: {lat, lon}` rounded with `Math.round(x*10)/10`
  (about 10 km). The region comes from bounding boxes documented in that
  file (five codes; Ontario in three boxes so Minnesota, Wisconsin and most
  of Michigan stay out; the Iowa/Illinois overlap split by a five-point
  polyline along the Mississippi; everything else `none`). `askSchema`
  stays `.strict()`: the enum is fixed, coordinates are range-checked and
  must have at most one decimal. The note under the Ask box shows the code
  and whether the rounded position will be added before anything is sent.
- **NatureServe (no key), `server/src/natureserve.ts`:** `POST
  https://explorer.natureserve.org/api/data/speciesSearch` with
  `{criteriaType:"species", textCriteria:[{paramType:"textSearch",
  searchToken:<scientific>, matchAgainst:"scientificName",
  operator:"equals"}], pagingOptions:{page:0, recordsPerPage:5}}`. Verified
  against https://explorer.natureserve.org/api-docs/ ("Species Search",
  "Text Criteria", "Species Result") on 2026-10-19: each result carries
  `scientificName`, `primaryCommonName`, `roundedGRank`, `nsxUrl` (relative)
  and `nations[].subnations[]` with `subnationCode` and `roundedSRank`, so
  the taxon endpoints (`GET /api/data/taxon/{uid}`, which return the same
  ranks as `elementNationals[].elementSubnationals[].roundedSRank` with
  `subnation.subnationCode`) are not needed. The fixture
  `server/test/fixtures/natureserve-robin.json` is a live recording of that
  call for *Turdus migratorius* (trimmed). Cache: SQLite `natureserve_cache`,
  one row per species (the record holds every S-rank, so the region is
  picked out at prompt time), 30 days, misses cached too. Ranks are expanded
  in the prompt ("S5B (secure, breeding population)"); range ranks such as
  G3G4 are left as they are.
- **eBird (`EBIRD_API_KEY`, optional), `server/src/ebird.ts`:** base
  `https://api.ebird.org/v2`, header `X-eBirdApiToken`. Verified against the
  eBird API 2.0 Postman documentation
  (https://documenter.getpostman.com/view/664302/S1ENwy59, read through its
  collection JSON on 2026-10-19): `GET /ref/taxonomy/ebird?fmt=json&cat=species`
  (rows `{sciName, comName, speciesCode, category, …}`; its `species`
  filter takes codes, not names, so the whole taxonomy is downloaded once
  and cached 30 days as one `ebird_cache` row, and scientific name → code
  is looked up in it); `GET /data/obs/{regionCode}/recent/{speciesCode}?back=30`
  (regionCode is the subnational1 code, i.e. the app's `US-IA` style codes);
  `GET /data/obs/geo/recent/{speciesCode}?lat=&lng=&back=30&dist=50`.
  Observation rows are reduced to locality name, date and count: private
  localities become "a private location", coordinates embedded in locality
  names (eBird auto-names them that way) are stripped, and observer names,
  checklist ids and coordinates never enter the prompt; at most 15 rows,
  newest first. Cache: `ebird_cache`, one hour per species+region and per
  species+rounded point. Without the key the source is skipped and startup
  logs only that it is not set. Fixtures: `ebird-taxonomy.json` (first row
  recorded live, the taxonomy endpoint needs no key), `ebird-obs-region.json`
  (doc-derived: the documentation's "Example 1" response, dates moved; no
  key was available to record live) and `sources-injected.json`
  (adversarial).
- **Pipeline:** `fetchExtraSources` runs both lookups concurrently with the
  Wikipedia fetch, 8-second timeouts, every failure non-fatal; the response
  adds `sources: [{name, url}]` (what was used) and `region`, and keeps
  `source`, `citations` (now with the full label and a `source` field) and
  `context` for older clients. The client shows "Sources: Wikipedia ·
  NatureServe Explorer · eBird" as links under the answer.
- **Injection defences kept:** every fetched field goes through `cleanField`
  (control characters and square brackets removed, 120 characters) and then
  `neutralizeFence` inside the single `<source>` fence; the NatureServe link
  is rebuilt from a validated relative path. `adversarial-sources.test.ts`
  proves an injected instruction in a locality/common name reaches the model
  only as data and that the leak check still rejects a compliant answer.
  See docs/SECURITY.md.
- **Alternatives:** letting the model call the APIs (rejected: tools widen
  the blast radius of an injection and the spec forbids it); sending the raw
  position (rejected: the region code and a 0.1° point are enough for both
  APIs); NatureServe `nation`/`subnation` location criteria instead of
  caching the whole record (one extra call per region for no gain).
- **Not verified:** live eBird observation responses (no key here); how well
  Gemini keeps to the role rules and the "sources differ" wording; the
  bounding boxes on a device near a border.

## 48. `/v1/ask` cost: token logging, lean context, minimal thinking, answer cache, model eval

- **Problem:** every question sent the whole selected article (up to 12,000
  characters, ~1,800 prompt tokens in the live logs) at thinking level LOW
  and the server had no idea what a day of questions cost.
- **Prices (verified 2026-10-19 on https://ai.google.dev/gemini-api/docs/pricing,
  Standard tier, USD per 1M tokens):** `gemini-3.8-flash` input "$0.75 through
  December 31, 2026" ("$1.50 starting January 1, 2027"), output "$3.75"
  ("$7.50"), cached input "$0.075" ("$0.15"); `gemini-3.5-flash-lite` input
  "$0.30 (text / image / video / audio)", output "$2.50", cached input "$0.03".
  The page labels every output price "(including thinking tokens)", so
  thinking tokens are billed at the output rate. `server/src/pricing.ts`
  holds the table (also `gemini-3.1-flash-lite` and `gemini-2.5-flash-lite`)
  with the URL and date; an unknown model yields cost `null`, logged as
  `cost_usd=unknown` and counted in `unpriced_requests`. The 2027 price rise
  is a comment, not code: the table must be revisited then.
- **Model IDs (https://ai.google.dev/gemini-api/docs/models, "Last updated
  2026-10-13"):** `gemini-3.8-flash` (Stable) and `gemini-3.5-flash-lite`
  (Stable; "For any new projects, use our latest models: 3.5 Flash-Lite or 3.8
  Flash"). `GEMINI_MODEL` stays configurable, default unchanged.
- **Thinking (https://ai.google.dev/gemini-api/docs/thinking):** the table
  lists `gemini-3.8-flash` with low, medium, high (default medium) and
  `gemini-3.5-flash-lite` with minimal, low, medium, high (default minimal).
  Neither can be turned off. `thinkingLevelFor(model)` sends MINIMAL to
  3.5 Flash-Lite and LOW to 3.8 Flash and to unknown models (`ThinkingLevel.
  MINIMAL` exists in `@google/genai` 2.30); `thinkingBudget` is still never
  sent (#43).
- **Implicit caching (https://ai.google.dev/gemini-api/docs/caching):**
  "enabled by default for all Gemini 2.5 and newer models"; "Try putting large
  and common contents at the beginning of your prompt" and "send requests with
  similar prefix in a short amount of time"; savings are passed on
  automatically and reported as cached tokens. The prompt already has the
  static system instruction first, then the source context, then the
  question, and the cost code bills `cachedContentTokenCount` at the cached
  rate. Caveat from the same page: the minimum prompt for an implicit cache
  hit on Gemini 3.8 Flash is 4,096 tokens (no minimum is listed for 3.5
  Flash-Lite), and this prompt is ~1,800 tokens at most, so a cache discount is
  not expected in practice; the ordering costs nothing and the smaller prompt
  saves more than a cache would.
- **Context (`server/src/context-select.ts`):** the Wikipedia sections are
  scored by keyword overlap between the question and the heading + text (lower-case,
  stop words removed, a light suffix strip so "eat" meets "eats" and "breed"
  meets "breeding"; a heading match counts three times). The lead always
  scores at least 1, so it is the fallback when nothing matches. Sections are
  added in score order until ~1,500 tokens (chars / 4; the last one cut at a
  word boundary with "[…]", dropped if fewer than 60 tokens fit) and sent in
  article order. The ~1,500 tokens are the whole fenced source: the
  NatureServe and eBird blocks (#47) are short and always sent whole, and
  `wikiTokenBudget()` gives Wikipedia what they leave, never below 400
  tokens. Citations still resolve against every section (same anchors and
  labels). The fence neutralisation, control stripping and leak markers are
  unchanged; the prompt order stays static instruction → source → question.
- **Answer cache (`server/src/answer-cache.ts`):** SQLite `answer_cache`
  keyed by SHA-256 of species + region code ("none" when absent) + the
  position rounded to 0.1° ("-" when absent) + normalised question
  (lower-case, trimmed, punctuation and symbols removed, whitespace
  collapsed, 200 characters), so the table never stores a question. The
  same question from another state or another place is another answer
  because the eBird sections differ (#47); the member is not in the key.
  Seven-day TTL from `created_at`;
  only successful answers are stored; expired rows are pruned on each write.
  A hit returns the same body plus `cached: true`, is served before the
  daily caps are checked and does not count against them.
- **Logging and totals:** the `[ask]` line gains `cost_usd=0.001875
  cached=false` (six decimals; a cache hit logs one line with
  `finish=CACHE … cost_usd=0.000000 cached=true`); still no question or
  answer text. `server/src/ask-cost.ts` keeps SQLite `ask_cost` per UTC day
  (requests = billed calls, retries included; prompt, answer, thinking and
  cached tokens; cost_micros; unpriced_requests; cache_hits). `GET
  /v1/admin/ask-costs` (admin only) returns the last 30 days and the
  configured model; the Admin page shows them as a table with totals
  (`src/ui/views/admin.ts`, `adminAskCosts()` in `src/api/client.ts`).
- **Eval (`server/scripts/eval-models.ts`, pieces in `server/src/eval-models.ts`):**
  20 fixed questions over 5 species (blackbird, great tit, robin, blue jay,
  house finch; one off-topic control), the real `answerQuestion` pipeline
  with the article fetched once per species so both models see the same
  context, `gemini-3.8-flash` versus `gemini-3.5-flash-lite`. It prints the
  worst-case plan first (1,500 context + instruction + question ≈ 1,758 prompt
  tokens, 200 answer and 150 thinking tokens per call: $0.0526 + $0.0280 =
  $0.081) and refuses above $0.10 or for an unpriced model; `--dry-run`
  makes no network call. Output is a Markdown table (question, each model's
  answer, prompt/answer/thinking tokens, cost) plus totals. `GEMINI_API_KEY`
  comes from the environment only.
- **Alternatives:** explicit context caches (storage fee per hour, and the
  prompt is below the implicit minimum anyway); an embedding-based section
  match (a second model call per question, more cost than it saves); caching
  per member or region (fewer hits for no benefit, since the answer depends
  on neither); thinking off (not offered on Gemini 3 text models).
- **Tests:** `server/test/ask-cost.test.ts` (prices and cost arithmetic,
  thinking level per model, log line, daily totals, cache normalisation and
  TTL with a fake clock, caps not charged for hits, failures not cached,
  keyword/stem/score, selection order and budget, admin endpoint, eval plan,
  refusal and table against `FakeGemini`), `tests/admin-costs.test.ts`
  (client call and table totals). `adversarial-llm.test.ts` now asks three
  different questions in its cap test, because a repeat is a cache hit.
- **Not verified:** a live call with `thinkingLevel: MINIMAL` on
  3.5 Flash-Lite and the eval itself (no API key in this environment: the
  script was run with `--dry-run` only); whether Gemini ever reports cached
  tokens for this prompt size; the Admin table on a phone.

## 49. `/v1/ask`: Ollama Cloud first, Gemini as automatic fallback

(Numbered 49 on branch `claude/ollama-provider`; #47 and #48 are taken by
other open branches, so this may be renumbered at merge.)

- **Decision:** `AI_PROVIDER_ORDER` (default `ollama,gemini`) names the
  providers `/v1/ask` tries, in order. `server/src/providers/index.ts` builds
  the chain at startup; a provider whose key is missing is skipped with one
  `[startup] … provider skipped` line (no error); with no provider left
  `/v1/ask` answers 502 `model_unavailable` as it did without
  `GEMINI_API_KEY`. The chain falls back to the next provider on any thrown
  failure (HTTP 429 whether the body says limit or queue, any 5xx, a network
  error, the 8 s timeout, a 401/403 from a wrong key, an unparseable body),
  on an empty reply, and on an answer cut at the output limit (Ollama
  `done_reason` other than `"stop"`; Gemini `MAX_TOKENS` after its own retry
  from #43). The last provider's cut answer is kept and marked "(answer cut
  short)" as before. When every provider fails, the existing 502
  `model_unavailable` is returned and the client shows "The answer service is
  unavailable right now": members never see a provider error.
- **Ollama Cloud, verified 2026-10-19:**
  - `https://docs.ollama.com/cloud`: the example is
    `curl https://ollama.com/api/chat -H "Authorization: Bearer $OLLAMA_API_KEY"
    -H "Content-Type: application/json" -d '{"model":"gemma4:31b","messages":[{"role":"user","content":"…"}],"stream":false}'`,
    "Read the answer from `message.content`", keys from
    `https://ollama.com/settings/keys`, "Browse cloud models, or list them with
    the API: `curl https://ollama.com/api/tags`", "For API requests to
    ollama.com, use the name returned by this list, such as `gemma4:31b`. In
    the Ollama app or CLI, use `gemma4:cloud`."
  - `https://docs.ollama.com/api/chat`: request `model`, `messages[]` with
    `role` (`system`, `user`, `assistant`, `tool`) and `content`, `stream`
    (default true), `options` (`temperature`, `num_predict` "Maximum number of
    tokens to generate", …), `think`, `keep_alive`; non-streaming response
    `message.role`/`message.content`/`message.thinking`, `done` ("Indicates
    whether the chat response has finished"), `done_reason` ("Reason the
    response finished", a string; **no values are enumerated**, so only
    `"stop"` is treated as complete and anything else as cut), `total_duration`,
    `prompt_eval_count` ("Number of tokens in the prompt"), `eval_count`
    ("Number of tokens generated in the response"). The example shows
    `"done_reason": "stop"`.
  - `https://docs.ollama.com/api/errors`: non-streaming errors are
    `{"error": "…"}`; status codes 400, 404, 429 "Too Many Requests (e.g. when a
    rate limit is exceeded)", 500, 502 "Bad Gateway (e.g. when a cloud model
    cannot be reached)". No limit or queue message strings are documented, so
    the server classifies 429 by the word "queue" in the body (log only) and
    falls back on any 429 regardless.
  - `https://ollama.com/pricing`: "Free includes 1 concurrent request, Pro 3,
    and Max and Team 10", "Requests beyond your plan's concurrency limit are
    queued and processed as soon as a slot is available", "if the queue is full,
    the request will be rejected until one of your concurrency slots opens";
    free usage resets monthly. Hence the 8 s `OLLAMA_TIMEOUT_MS` and the
    single Ollama attempt per request (no retry: a second call would wait on
    the same single slot; the budget is `num_predict` 1,400, the larger of the
    two Gemini budgets).
  - **Live, 2026-10-19 (from Sabih's server):** `POST https://ollama.com/api/chat`
    with `Authorization: Bearer <OLLAMA_API_KEY>` and
    `{"model":"gpt-oss:20b","messages":[…],"stream":false}` returned HTTP 200,
    so the endpoint, header and request shape are confirmed against the
    account; the response fields above come from the docs.
  - **Unverified:** the set of `done_reason` values (the local Ollama server
    uses `"length"` for a `num_predict` cut; the test fake mirrors that);
    whether `num_predict` also bounds `message.thinking` on thinking models;
    the exact 429 body text; whether `/api/tags` against `ollama.com` needs
    the bearer header (the docs' example sends none; the checklist sends it).
    `https://docs.ollama.com/cloud/models`, `/cloud/usage`, `/cloud/pricing`
    and `/api/openapi` answered 404.
- **Model:** `OLLAMA_MODEL=gemma4:31b`, **Sabih's choice**, set explicitly in
  the live `.env` (the config default applies only when unset; nothing in the
  code names a model). Shortlist from `https://ollama.com/search?c=cloud`
  (20 cloud models on 2026-10-19) and the library pages, instruction-following
  text models with a `system` role: `gemma4:31b` (the docs' own example;
  library page: "native support for the `system` role", 256K context, tags
  `31b-cloud`/`cloud`), `nemotron-3-nano:30b` (30B MoE, 3.5B active, "unified
  model for both reasoning and non-reasoning tasks", `30b-cloud`) and
  `gpt-oss:20b` (confirmed live on this account; absent from the search page
  that day). `mistral-large-3:675b` has tools and vision but no thinking and
  is a Pro-sized model. The list of models the account can use:
  `curl -s https://ollama.com/api/tags -H "Authorization: Bearer $OLLAMA_API_KEY"`.
  Which of the three answers best is **provisional** until
  `scripts/eval-models.ts` has run with both keys (no key here).
- **Same prompt both ways:** `SYSTEM_INSTRUCTION` is the system message,
  `buildPrompt` (fenced source + question) the user message; Gemini keeps its
  `systemInstruction` config. `leaksSystemPrompt`, `toPlainText` and the
  2,000-character cap stay in `answerQuestion`, after the model call, so they
  apply to whichever provider answered. `server/test/adversarial-ollama.test.ts`
  runs the #8 probes (injection through the question and the extract, leak
  verbatim and paraphrased, markup, too long, empty, failures, odd Unicode)
  through the Ollama provider with the same `gemini-responses.json` fixtures;
  `adversarial-llm.test.ts` keeps the Gemini run.
- **Logging:** per answered request one line
  `[ask] provider=ollama model=gemma4:31b fallback_from=- fallback_reason=-
  finish=stop prompt_tokens= answer_tokens= total_tokens= duration_ms=
  day_requests= day_prompt_tokens= day_answer_tokens= day_fallbacks=`
  (`fallback_from=ollama fallback_reason=timeout` when Gemini stepped in; a
  failed provider logs `[ask] provider=ollama failed reason=rate_limit
  (falling back)`); Gemini's per-attempt `[ask] attempt=` lines with cost (#48)
  stay. Never the question, the answer or a key. `server/src/provider-usage.ts`
  keeps SQLite `ask_provider_usage` (day, provider, requests, prompt_tokens,
  answer_tokens, fallbacks); `GET /v1/admin/ask-costs` adds `providerOrder`,
  `models` and `providers[]` (one row per provider over 30 days) and the
  Admin page shows them above the Gemini cost table, so the free allowance
  drain is visible. `ask_cost` (#48) still records Gemini's billed calls only;
  Ollama has no list price.
- **Eval:** `scripts/eval-models.ts` adds an `ollama:<OLLAMA_MODEL>` column
  (`--ollama gemma4:31b`, `--no-ollama`) and four adversarial cases
  (`server/src/eval-adversarial.ts`: injection via the question, injection via
  an extra article section, a leak request, a markup request). Every answer
  carries flags computed from the raw reply before the server's output rules:
  `provider_error`, `empty`, `cut_off`, `leak`, `injected`, `markup`; the
  totals table counts flagged answers per model. The plan prices Gemini only
  and lists Ollama as plan allowance. Run on the server or locally:
  `cd server && GEMINI_API_KEY=… OLLAMA_API_KEY=… npm run eval -- --models gemini-3.5-flash-lite --ollama gemma4:31b`
  (`--dry-run` first; no key in this environment, so only the dry run was
  executed here).
- **Alternatives:** the OpenAI-compatible `https://ollama.com/v1` endpoint
  (would need the OpenAI SDK or a second request shape for nothing gained);
  the `ollama` npm package (a dependency for one POST); streaming (no need);
  retrying Ollama before falling back (the single free slot makes the wait
  longer than the Gemini fallback).
- **Tests:** `server/test/providers.test.ts` (order parsing, skip without
  key, request shape, each failure kind, timeout honouring the abort signal,
  every fallback reason, reverse order, cut answer kept on the last provider,
  both-fail 502, log fields), `adversarial-ollama.test.ts`,
  `provider-usage.test.ts` (daily totals, log day counts, configured model
  names reach both fakes, admin rows, eval flags and the adversarial cases
  through both providers), `tests/admin-costs.test.ts` (provider rows).
- **Not verified:** a live Ollama answer through the chain (no key here; see
  `docs/LIVE_HARDENING.md` for the drill), the fallback timing on the free
  plan's single slot, and the Admin table on a phone.

## 50. Account deletion: password + DELETE, one transaction, no grace period

- **Decision:** Settings › Account › "Delete my account" asks for the
  password again and the word DELETE (button disabled until both are
  filled; a wrong word is caught on the device and again on the server).
  `POST /v1/me/delete` takes `{ password, confirm: 'DELETE' }` (strict),
  refuses the admin account first (400 `admin_account`, message "The admin
  account can’t be deleted from the app, because it approves other members.
  Ask Sabih."), verifies the password with `auth.api.signInEmail`, then
  runs `deleteUserCompletely` (`server/src/account-deletion.ts`): one
  `BEGIN IMMEDIATE` transaction over `shared_species`, `friendship`,
  `friend_invite`, `invite_usage`, `ask_usage`, `login_challenge`,
  `verification`, `session`, `account`, `user`. After the commit a short
  confirmation mail goes to the address (failure logged, not returned).
  The app then shows a confirmation screen (`account-deleted`) with "Also
  clear sightings saved on this phone" unchecked; Done with it checked runs
  `clearAllData()` on the device. Listening keeps working either way.
- **Better Auth checked (1.7.11, `@better-auth/core` types and
  `dist/api/routes/update-user.mjs`, and the docs page "Delete User",
  2026-10-19):** `user.deleteUser.enabled`, `sendDeleteAccountVerification`,
  `beforeDelete`, `afterDelete`, `deleteTokenExpiresIn` exist, and
  `auth.api.deleteUser` accepts `password` (verified with
  `ctx.context.password.verify`) or else needs a session younger than
  `session.freshAge` (24 h). Its deletion is `internalAdapter.deleteUser`
  then `deleteUserSessions`, two separate adapter calls outside any
  transaction, and the hooks run before and after them, so the app's own
  tables could not be wiped atomically with the user row. Not used; the
  password check it does is the same scrypt verify that `signInEmail`
  performs, so that documented call is used instead and the extra session
  row dies in the transaction.
- **What is not on the server:** sightings, clips, detections and ticks
  (IndexedDB only; the ticks are derived from the sightings store); clip
  files (none exist on the server, so there is no file step); stored
  questions tied to a person. The answer cache from #48 (`answer_cache`) is
  keyed by species + region + rounded position + normalised question, never
  by user id or address, and expires after seven days; `ask_cost` holds
  per-day totals only. The source caches are keyed by species.
- **"What we store":** `src/ui/components/what-we-store.ts`, one paragraph
  derived from the code, on the sign-up form and in the Account card,
  ending with "Copies in server backups are removed when those backups
  expire." It names Gemini only: there is no Ollama in the code.
- **Tests:** `server/test/account-deletion.test.ts` (every table from
  `sqlite_master` free of the id, the address and the ask scope; both tokens
  401; the former friend's and invitee's lists empty; admin 400; wrong
  password / wrong word / missing field / extra field 400 with the snapshot
  unchanged; mail sent, mail failure harmless; pending account may delete),
  `tests/what-we-store.test.ts`, `tests/api-client.test.ts`, and the e2e
  member test (disabled button, wrong word does nothing, stubbed success
  shows the confirmation screen, session gone, sighting kept).
- **Not verified:** the live mail and the retention of `VACUUM INTO`
  backups on the server (the PR asks the PC session to confirm it).


## 51. Recent sightings: one 30 s lumping rule, grouped per species on Listen

- **What Sabih saw (2026-10-19):** Listen → Recent sightings listed Eastern
  Bluebird at 3:34:15, :17, :18 and :20 and Mourning Dove at :06, :08 and :09,
  although a 60 s sighting merge existed.
- **Cause:** the 60 s rule lived only in storage. `recordDetections` folded
  each analysis window into a `sightings` row correctly (reproduced with that
  exact sequence in `tests/sightings.test.ts`: 7 stored hits, 2 sightings),
  but the Listen screen never read `sightings`. "Recent sightings" rendered
  an in-memory list of every window hit (`recent.slice(-8)`), and the live
  result list showed the latest hit per species. The merge was invisible
  where it mattered.
- **Decision: one rule, 30 s, rolling, in one constant.**
  `LUMP_GAP_SECONDS = 30` in `src/species/recent.ts` lumps hits of a species
  when no more than 30 s separates one hit from the next (a bird singing
  steadily stays one detection). The stored sightings now use the same
  constant (`DEFAULT_SIGHTING_GAP_SECONDS = LUMP_GAP_SECONDS`), the
  "New sighting after" slider is gone, and DB version 5 re-lumps the existing
  `sightings` rows from the stored hits once. Stored per-window hits are never
  dropped or merged (history, the heat map, clips and ticks need them); only
  their `sightingId` links change.
- **Display (`src/ui/components/recent-group-card.ts`, `src/ui/views/listen.ts`):**
  one card per species, ordered by last heard, newest first; name, scientific
  name, best confidence labelled "best", "Heard once" / "Heard N times" (N =
  lumped detections, not raw hits) and "last <end of the newest detection>".
  The header reads "N birds · N detections". The whole card is a button
  (≥ 44 px, `aria-expanded`, label "Eastern Bluebird, heard once, best 100%,
  last at 3:34 PM"); tapping it lists the detections, newest first, each with
  a time range when it spans several hits ("3:34:15–3:34:20 PM"), the hit
  count and the best confidence. Members get the species' saved clip (the
  best one kept). The live results list reuses the same grouping: one result
  card per species with "best", the count and the time last heard; Focus mode
  shows the newest species large. The scope is this Listen view's session
  (up to 400 hits kept), as before.
- **Alternatives:** keep two rules (60 s stored, 30 s shown): rejected, the
  numbers would disagree between Listen and the history. Count raw hits:
  rejected, every 1.5 s window would inflate the number. Merge stored hits:
  rejected, history and clips need each window.
- **Tests:** `tests/recent.test.ts` (29 s merges, 31 s splits, a 20-hit chain
  stays one detection, sort order, a new hit moves the card up and bumps the
  count, counts, labels, expand/collapse state), `tests/sightings.test.ts`
  (the phone sequence, the version-5 re-lump, stored hits untouched), and a
  Playwright test per Listen layout (card, aria-expanded, rows, collapse, no
  overflow). Screenshots: `docs/screenshots/listen-recent-{grouped,expanded}-{dark,light}.png`.

## 52. Server maintenance scripts are read-only planners, run by hand, tested against a fake tree

(Numbered #50 while #48 cost and #49 Ollama are on open branches; may be renumbered on merge.)

- **Decision:** `scripts/server/update-planner.sh` and
  `scripts/server/backup-restore-test.sh` (docs/SERVER_RUNBOOK.md) are copied to
  the host and run by a normal user; nothing in CI or in the app runs them.
  The host also serves other projects, so the scripts only *read* system state
  (`apt list --upgradable` / `apt-get -s upgrade`, `/var/run/reboot-required*`,
  `needrestart -b`) and only *write* under `/opt/birdbrain` (`reports/`,
  `tmp/`). Neither ever calls `apt-get install`, `systemctl`, `docker compose
  down/up/restart/stop` or `docker exec` on the live container. Both refuse to
  run as root (exit 77); the restore test calls `sudo` itself for the three
  things that need it on this host (root-owned `/opt/birdbrain`, `docker
  compose` reading the root-only `.env`, and the root-only volume paths for the
  sqlite3 engine) and prints the reason first.
- **Restore test design:** the newest `birdbrain-*.db` in the `birdbrain-backups`
  volume is copied into `mktemp -d /opt/birdbrain/tmp/restore-test.XXXXXX`,
  opened read-write (the restore), `PRAGMA integrity_check`ed and counted per
  table; the live `/data/birdbrain.db` is opened `{ readOnly: true }`
  (`node:sqlite`) or `sqlite3 -readonly`; an `EXIT` trap removes the folder on
  every path. Preferred engine is the api image itself via `docker compose run
  --rm --no-deps -T` (no ports, separate one-off container, same `node:sqlite`
  the app uses); the sqlite3 CLI is the fallback. Exit 3 when no backup exists.
- **Tests:** `scripts/server/test.sh` (47 checks, run by CI after `npm test`)
  drives both scripts with `--dry-run` and for real against a temp tree, a fake
  `docker` (runs the node program locally; exits 99 on down/restart/stop/up)
  and a fake `sudo`. Test hooks are environment variables (`BIRDBRAIN_HOME`,
  `BB_RUN_DIR`, `BB_APT_LIST_FILE`, `BB_DOCKER`, `BB_SUDO`, `BB_TEST_UID`);
  `shellcheck -S style` is clean (0.11.0).
- **Alternatives rejected:** running the restore in a second compose project on
  `127.0.0.1:<port>` (the app is not needed to compare counts, and a second API
  on the host is more surface); `unattended-upgrades` or any auto-apply (shared
  host, kernel/docker upgrades restart the other projects); opening the live DB
  with `immutable=1` (silently wrong reads under concurrent writes; `readOnly`
  is enough).
- **Not verified (no server access from this session):** that `sqlite3` or
  `needrestart` are installed on the host, that `docker compose run -v` with a
  bind under `/opt/birdbrain/tmp` works with the image's `read_only` root
  filesystem (the bind is a separate mount, so it should), and the actual
  backup listing; docs/SERVER_RUNBOOK.md §3 lists the read-only checks to run
  first.

## 53. Hard $2/month Gemini cap, enforced in the provider chain

- **Decision:** `GEMINI_MONTHLY_CAP_USD` (default 2.00, per UTC calendar month)
  is enforced by `createGeminiCapGuard` (`server/src/gemini-cap.ts`) wrapped
  around the Gemini provider in `configuredProviders`. Before every Gemini
  call the month's estimated spend is read from the existing `ask_cost` table
  (one row per UTC day, #48); at or over the cap the call is skipped with
  `ProviderError('cap')`, so the chain falls back to Ollama, and when every
  provider fails the member sees "Bird questions are busy right now. Please
  try again in a few minutes." (the `model_unavailable` text). A cap of 0
  disables Gemini.
- **Pricing rule:** one table (`server/src/pricing.ts`, from #26); an unknown
  model is billed at the most expensive known price (`maxKnownPrice`, today
  gemini-3.8-flash at $0.75 in / $3.75 out) so a renamed model cannot slip
  under the cap; `GEMINI_PRICE_IN` / `GEMINI_PRICE_OUT` override the rates
  for the configured model. Every Gemini call is therefore priced
  (`unpricedRequests` stays 0 from now on). The eval script keeps "plan
  allowance" for Ollama models: it is not under the cap.
- **Alerts:** at 50 % and 100 % of the cap the admin is mailed through the
  existing SMTP mailer, once per level per month, recorded in the new
  `ask_cost_alert (month, level)` table so a restart cannot repeat a mail; a
  failed mail is logged and never fails the member's request.
- **Where it shows:** `GET /v1/admin/ask-costs` gains `month` (spend, cap,
  percent, alerts sent) and the admin view a "Gemini this month" line; never
  on the public `/health`.
- **Alternatives:** a separate monthly table (rejected: the daily rows already
  sum per month); counting the cap before recording (rejected: the check runs
  before the call and the alerts after it, so a call that crosses the cap
  still completes and is counted); hard-failing at the cap (rejected: Ollama
  answers first by design, #49).
- **Tests:** `server/test/gemini-cap.test.ts`: unknown model → highest price,
  overrides, month sum and rollover, cap reached → no Gemini call (guard and
  full chain with Ollama down → 502), cap 0, each alert once, failed mail
  logged, mail wording. Existing cost tests updated to the new pricing rule.

## 54. Hardening runner and output filter for `/v1/ask`

- **Decision:** PR #8's adversarial checklist becomes `npm run harden`
  (`server/src/hardening/{cases,runner,cli}.ts`, `docs/HARDENING_RUN.md`):
  13 cases with stable IDs run through the real `answerQuestion` and the
  live provider chain from inside the API container, with an in-memory
  database (the live one is never opened), the real Wikipedia / NatureServe /
  eBird text plus the case's injected text, raw replies captured before the
  server's rules, a Gemini budget stop (`--budget`, default $0.05, also
  counted by the monthly cap) and a dated JSON report. A case passes when the
  member-facing answer is safe; a model that misbehaved but was caught is
  recorded (`modelMisbehaved`, `rawFlags`), not failed.
- **Defence in depth added:** `server/src/hardening/filters.ts` runs after
  `toPlainText` on every answer: a system-prompt echo is rejected (existing
  rule), env-like assignments and secret-shaped tokens are redacted, decimal
  coordinate pairs are redacted ("[location removed]"), and markup or runaway
  raw output is flagged in the `[ask]` log line (never the text). Input
  limits already in place and now exercised by a case: 500-character
  question, strict body schema, 16 KB body, species must be a BirdNET label,
  fenced and labelled source text with fence tags neutralised.
- **Alternatives:** a separate adversarial eval model (rejected: judging must
  be deterministic and cheap); failing a case whenever the model misbehaves
  (rejected: the server's rules are the control under test, the model's
  behaviour is reported alongside); blocking all numbers to catch coordinates
  (rejected: counts, dates and percentages are legitimate; only two-decimal
  pairs in coordinate range are redacted).
- **Tests:** `server/test/hardening.test.ts`: each filter rule, the judge
  (pass, followed injection, server-caught leak, wrong status, coordinates,
  runaway), the oversized case against the real route (400), the live filter
  redacting a coordinate pair and a planted secret in a member answer, the
  dry run, and a forced provider without its key.

## 55. Backups stay on the server: 14-day retention plus a hard 5 GiB cap, no off-box copy

- **Decision (Sabih, 2026-10-20):** the nightly `VACUUM INTO` backup keeps its
  14-day retention and gains a hard size cap on the backup folder
  (`BACKUP_MAX_BYTES`, default 5 GiB): before a backup is written, the oldest
  files are deleted until the existing ones plus the new one (estimated from
  the live database's size) fit; a single backup larger than the cap is still
  written, with a warning. The logic moved to `server/src/backup-lib.ts`
  (`runBackup`, injectable clock and logger) so `server/test/backup.test.ts`
  can run it against real SQLite files in a temp folder; `backup.ts` stays the
  container entry point and only reads the environment.
- **Removed:** the monthly copy to Sabih's PC (Windows scheduled task,
  `pull-backup.ps1`, the optional Seagate copy and the local folder, which held
  e-mail addresses and password hashes), the proposed sudoers rule for the
  restore test and any idea of a scheduled restore test. The restore-test
  script stays for runs by hand (docs/SERVER_RUNBOOK.md).
- **Why:** one place to protect and to wipe. The privacy note promises only
  "copies in the nightly server backup are removed within 14 days", which the
  retention rule keeps true; the cap protects the shared host's disk if the
  database ever grows, without needing anyone to notice.
- **Alternatives rejected:** counting files instead of bytes (a few large files
  would still fill the disk); pruning after writing (the write itself could be
  what fills the disk); an off-box copy to a paid store (Sabih: no paid
  services, keep it simple).
## 56. The BirdNET weights are served from the API host, not from the front end

- **Problem:** every Vercel deployment carried the 23 model files (78 MiB), so
  each push paid for them twice over: deployment storage per build, and Fast
  Data Transfer every time a phone downloaded the model (3.07 GB in the last 30
  days, nearly all of it model traffic).
- **Decision:** the weights live in `models/birdnet-v2.4/` in the repository
  (out of `public/`, so no build copies them) and are published to the server
  with `scripts/server/publish-model.sh`, which hash-checks them against
  `models/birdnet-v2.4/SHA256SUMS` locally and again on the server, stages them
  in `<dir>.new` and swaps that into place, so a failed copy never replaces a
  working folder. Nginx serves `/models/` from `/opt/birdbrain/models` (`root`,
  not `alias`, so `try_files` stays simple) with `Cache-Control: public,
  max-age=31536000, immutable`, its own lenient `limit_req`/`limit_conn` zones
  (the API's 6 r/min would block a cold start), `limit_except GET HEAD OPTIONS`,
  and CORS only for this app's origins through an http-level `map` on
  `$http_origin` (the production site and `sabihs-birdbrain-*.vercel.app`
  previews; any other origin gets no header, so the browser blocks it). The
  security headers are repeated inside the location, because a location-level
  `add_header` drops the server-level ones.
- **In the app:** `src/model/model-source.ts` is the single place that decides
  where the model comes from: `VITE_MODEL_BASE_URL` if set, else the app's own
  origin in `vite dev` (`scripts/serve-models.mts` serves the repository folder
  in dev and preview), else `https://bird-brain.duckdns.org/models/birdnet-v2.4/`.
  `labels.json` stays in `public/` and is still precached: the offline species
  list must work without the weights. The service worker gets a second
  `CacheFirst` route for the absolute model URL, because a Workbox regular
  expression only matches a cross-origin request when it matches from the start
  of the URL; the worker's own Cache API copy is unchanged.
- **When the download fails** the member sees "Couldn't download the bird model.
  Check your connection and try again." with a Try again button that re-runs the
  download (`AppController.loadModel`), instead of the old generic
  "Something went wrong"; the technical reason goes to the console only.
- **One copy on the phone:** the first load from the new source deletes any entry
  in the `birdnet-models-v2.4` cache that is not under the current base URL
  (`staleModelEntries`, `src/model/model-cache.ts`), so an installed app does not
  keep the 78 MiB it downloaded from Vercel beside the new copy. Existing
  installs do download the model once more, which cannot be avoided: the URL is
  part of a Cache API key.
- **Guards:** `npm run check:dist` fails the build if any weight file or model
  topology is in `dist/`, or if `dist/` grows past 12 MiB (it is 3.4 MiB now);
  CI runs it, and builds with `VITE_MODEL_BASE_URL=/models/birdnet-v2.4/` so the
  e2e run never downloads from the live server.
- **Alternatives rejected:** a paid CDN or object store (Sabih: no paid
  services); keeping the files on Vercel and caching harder (does not reduce the
  first download, which is the bulk of the transfer); a wildcard
  `Access-Control-Allow-Origin` (any site could then use our bandwidth); `alias`
  with `try_files` (resolves the prefix twice and 404s).

## 57. Settings and Listen fit a phone: grouped rows and collapsed sections

- **Problem:** the Account card and "How it works" were long columns of
  paragraphs, switches and seven step cards. On a 320 px screen the Account
  card alone was several screens of scrolling, and the privacy paragraph was
  the longest block in the app.
- **Decision:** nothing is deleted; long text moves behind a collapsed section
  and the controls become grouped rows.
  - `src/ui/components/rows.ts`: a group of full-width rows (action, link,
    switch, static), each at least 48 px tall, with the chevron and the focus
    ring. The Account card now shows an avatar, the display name, the email and
    an Admin/Member pill, then rows only for features that already exist:
    display name, admin page, the sharing switch, friends and invites, sign out
    and delete.
  - `src/ui/components/disclosure.ts`: one helper for every collapsed section,
    native `<details>`/`<summary>` so Enter, Space and the screen-reader
    expanded state come for free, 44 px minimum and no chevron animation under
    prefers-reduced-motion.
  - **Deleting an account** opens its own screen (password plus the word
    DELETE) instead of unfolding inside the card, and for the admin the row is
    disabled with "Not available for the admin account" in place of the old
    paragraph.
  - **"What we store"** is the last thing on Settings, closed, summarised as
    "Sightings stay on your phone", and its facts are five short groups: on the
    server, only on this phone, if sharing is on, when you ask about a bird,
    deleting your account. The one-line paragraph is still exported and is now
    built from those groups, so the test that checks every fact also proves
    nothing was lost in the regrouping. The sign-up form keeps one short line
    plus the same section.
- **"How BirdNET decides"** replaces the seven step cards inside "How it
  works": closed it is a chip strip (Mic › Resample › Window › Spectrogram ›
  Network › Location › Result), open a numbered list with one muted line each
  and the limits note at the end. It starts closed and remembers its state for
  the session only.
- **Live chips:** the same `stage` events that lit the old step dots now light
  the chips and the number badges. The running stage takes the accent fill, the
  ones already finished in the same 3-second window a soft tint, and the next
  window clears them; a stage earlier than the last one is what marks that
  boundary, so the mic firing once per audio chunk changes nothing. Changes are
  spaced by at least 300 ms, a "● Listening" label sits next to the title while
  the mic is on, everything is plain when it is off, and with
  prefers-reduced-motion only a finished window lights Result. The chips carry
  `aria-hidden`, so none of this is announced. The state lives in
  `src/ui/viz/pipeline-state.ts` as plain data, which is what the unit tests
  drive; the view only writes class names and never re-renders the screen.
- **Alternatives rejected:** a tab bar or a separate Account page (more
  navigation for a card most people open once); keeping the paragraph and
  shortening it (the facts are the point); animating the chips from new
  instrumentation (the existing events are enough, and a second source could
  disagree with the first).

## 58. A sighting is stamped with the fix taken at that moment, not at page load

- **Bug:** on a walk every sighting landed on the same spot. `persistDetections` copied
  `LocationManager`'s cached position onto each detection, and that manager asked the
  device for a position once (at startup, or at the first listen when none existed yet)
  and never again. The single call also used `enableHighAccuracy: false` with
  `maximumAge: 5 * 60 * 1000`, so even that one fix could be a five-minute-old network
  fix. There was no `watchPosition` anywhere in the code.
- **Decision:** separate the two uses of location.
  - `src/app/location.ts` (`LocationManager`) stays as it is and keeps serving the
    species filter, which only needs a coarse position.
  - `src/app/position-watch.ts` (`PositionWatch`) is new and is what a sighting is
    stamped from: `watchPosition` with `enableHighAccuracy: true` and
    `maximumAge: 5_000`, started when listening starts and stopped when it stops, so the
    GPS is not left running. `current()` is the newest fix, or null.
- **What is stored:** each detection takes `positionStamp(current())` at the moment it is
  persisted: latitude, longitude, accuracy in metres and `fixTime`, the moment the device
  produced the fix. The sighting carries the fix time of whichever position it kept, and
  so do clips and recordings saved while listening. Nothing new goes to the server;
  sightings stay on the phone.
- **Approximate:** a position is shown as approximate when the fix was already older than
  60 s at detection time, when the accuracy is worse than 100 m, or when the device gave
  no accuracy. The card and the history show "±12 m" or "approximate (±1.4 km)", in words
  and not by colour alone.
- **No fix, no position:** when location is denied or unavailable the sighting is saved
  without one. An old fix is never reused, and `stop()` drops the fix so the next session
  cannot inherit it.
- **Old sightings** cannot be corrected and are left alone. They are recognisable because
  they have no `fixTime`, so they show "Saved before the app followed your position:
  location may be from session start" and count as approximate.
- **iOS Precise Location** cannot be read from the Geolocation API. An accuracy of a
  kilometre or more is the only signal, so a fix that coarse shows a one-line hint
  pointing at Settings › Privacy & Security › Location Services › Precise Location.
- **Alternatives rejected:** refreshing `getCurrentPosition` on a timer (a watch is what
  the platform provides, and it stops cleanly); keeping one shared position for both the
  filter and the stamp (the filter would force the stamp to be coarse, or the stamp would
  make the filter recompute constantly); rewriting old rows with a guess (there is nothing
  to guess from).

## 59. The Listen layout is a live setting, and the three layouts differ in Ready too

- **Bug:** picking a layout in Settings appeared to do nothing, and two layouts looked the
  same. Two causes, both real:
  - `listenView` read `settings.get().listenLayout` into a `const` when the view was
    built, and the settings subscription only refreshed the chips and the results. While
    the screen stayed open, which is the case when switching during a session, nothing
    changed.
  - Navigating back did rebuild the view and did read the new value, but every layout
    rendered the same Ready block: the round mic button, the chips and the two collapsed
    rows. Consolidated and Focus were identical before Start, and Bottom dock was the same
    plus a bar. Every layout-specific arrangement existed only in the listening state,
    which is why pressing Start seemed to fix it.
- **Decision:** `applyLayout(next)` owns the arrangement and the view subscribes to the
  setting. It moves the existing nodes into the right parents and sets `data-layout`;
  nothing is rebuilt, so the microphone, the audio pipeline, the canvases and the
  detection state survive a switch mid-session. The Ready state now differs per layout:
  Consolidated keeps the round mic button, Bottom dock has no mic button at all and fills
  the screen with cards above its bar, and Focus shows one extra-large button with "Last
  bird: …" and nothing else.
- **One row on Listen:** the layout spec has exactly two collapsed rows, "How BirdNET
  decides" and "Recent sightings". The separate "How it works" row is gone and its live
  waveform, spectrogram and timeline now open inside "How BirdNET decides", above the
  numbered steps, which still end with the limits note. Nothing was dropped, and Focus
  shows neither row.
- **Tests:** the Playwright suite picks each layout in Settings, goes to Listen without
  pressing Start and asserts the signature (Consolidated has the round button and no dock,
  Bottom dock has the dock and no round button, Focus has the big button and no lists),
  then repeats while listening, switches layout three times mid-session and asserts that
  `getUserMedia` was not called again, and checks the choice survives a reload and is
  right on the first paint.
- **Alternatives rejected:** rebuilding the view on a layout change (simplest, but it
  would tear down the canvases and risk the audio path for a purely visual setting);
  three separate view modules (they share every component and state, so it would be three
  copies of the same wiring).

## 60. Auto-save of detection windows is on by default

- **Why:** members and non-members alike saw ticks on the Species tab but an
  empty Recordings tab, because only sightings are stored by default and the
  audio auto-save was off. Sabih asked for it on for everyone.
- **Decision:** `autoSaveClips` defaults to `true`. Settings version 2 → 3
  switches it on once for settings saved earlier, because a saved `false`
  cannot be told apart from the old default; turning it off afterwards is kept
  (version 3 values are respected). It is a per-device setting, the same for
  signed-out, member and admin use.
- **Cost:** each saved window is about 280 KB of browser storage (16-bit WAV,
  3 s at 48 kHz); the existing storage-quota warning still applies.
- **Not changed:** the 3-second window itself, which is BirdNET V2.4's fixed
  input (144,000 samples at 48 kHz).

## 61. Admin user management on its own page; 8-character passwords; reset by emailed temporary password

- **Request:** Sabih (the only admin) asked for sign-off on every new account (already the
  case: Better Auth's create hook stores `pending` unless the address is `ADMIN_EMAIL`, and
  `server/test/admin-users.test.ts` now asserts it), a password minimum of 8, and an
  admin-only place to reset passwords and delete accounts, reached by a button in Settings.
- **Password length:** 8 to 128, in Better Auth's `minPasswordLength` and in the request
  schema (`passwordSchema`), and in the form hints. Only the minimum moved, so every
  existing password (10+) still signs in.
- **Page and route:** `#/admin` already held the member list and the cost tables. The member
  list moved to a new `#/admin/users` page titled "User management"; `#/admin` keeps the
  cost tables under "Ask costs" with a "‹ User management" link back, and User management
  links to Ask costs at the bottom. Settings › Account shows one row, "Manage users", only
  when the cached user is the approved admin (`canManageUsers` in `src/app/access.ts`);
  anyone else who opens either URL sees "Only the admin can open this page." The server
  is the real gate: every admin route answers 403 without an approved admin session. The
  sign-up notification mail now links to `#/admin/users`.
- **Reset password:** `POST /v1/admin/users/:id/reset-password` draws a 16-character
  temporary password (57-symbol alphabet without look-alikes, `crypto.randomBytes` with
  rejection sampling), stores it through Better Auth's own context, ends every session,
  drops half-finished sign-in codes and emails it to the user. The admin never sees it;
  the answer is `{ ok, emailed }`, and a failed mail keeps the reset with `emailed: false`
  so the page can say "Password reset, but the email could not be sent. Try again."
  Hashing: `(await auth.$context).password.hash` and `internalAdapter.updatePassword` /
  `deleteUserSessions` (better-auth 1.7.11, `dist/db/internal-adapter.mjs`), the same calls
  the admin plugin's `setUserPassword` makes. The plugin itself was not added: it brings
  its own roles, bans and impersonation endpoints and schema fields that would overlap our
  `status`/`role` columns.
- **Change password:** so the mail's "change it in Settings → Account" is true,
  `POST /v1/me/password` calls Better Auth's documented `changePassword` with
  `revokeOtherSessions: true`; the device that changed it gets the new token and a notice
  mail goes to the address.
- **Delete user:** `POST /v1/admin/users/:id/delete` reuses `deleteUserCompletely` (one
  transaction) and the existing confirmation mail. The body must repeat the address, and
  the page enables the button only once the address is typed.
- **Not on the admin:** reset and delete answer 400 `own_account` for the admin's own id or
  any admin account; the admin's row has no buttons.
- **Every action asks first,** inside the row (Approve, Reject and Disable too), and the
  result is one plain sentence in a polite live region.
- **Alternatives rejected:** a reset link by email (needs a token flow, expiry and a
  landing page, more to review than a temporary password for a handful of accounts);
  letting the admin type or see the new password (the admin should never hold a member's
  password); keeping users and costs on one `#/admin` page under a new heading (the page
  is long on a phone, and the request was for a dedicated page).

## 62. "Why this ID" sits in the Spectrogram card, explains itself, and defaults to Medium

- **Placement:** the occlusion result is drawn on the recording's spectrogram,
  so the button and result moved from their own card into the Spectrogram
  card, under the confidence line.
- **Explanation:** after a run, three short lines say what was found (the
  confidence on that window and how far it falls when its most important
  part is silenced), how to read the coloured boxes (stronger colour = the
  model relied on it more; clear = barely mattered; time left to right, pitch
  low to high) and which grid was used (`src/ui/why-text.ts`).
- **Default:** Medium (8×6, 49 runs) for everyone. Settings version 3 → 4 sets
  it once on phones that saved settings earlier; a later choice is kept. The
  Settings hint is one line: "Finer uses more CPU and battery; Coarse uses less."

## 63. Listen opens in Focus on first run; a chosen layout is remembered

- **Request:** first-time users, and anyone who deletes all their data, start
  in the Focus layout; a layout the user picks is kept for later visits.
- **Decision:** `listenLayout` defaults to `'focus'` (an unknown stored value
  also falls back to it). The choice is stored with the other settings in
  localStorage, so it survives reloads and app restarts. Both "delete all
  data" paths (Settings › Data, and the after-deletion "Also clear sightings
  saved on this phone") set it back to Focus; clearing site data in the
  browser removes the settings and therefore also starts in Focus.
- **Not migrated:** phones already in use keep their stored layout, because a
  stored value cannot be told apart from a choice and the request was about
  first-time use.

## 64. The API's nginx rate limit is a coarse guard, and a refused sync says so

- **Bug:** "Spotted by friends" stayed at 0 for two members who had both turned
  sharing on. The friendship and the server query were fine. Two things hid it:
  nginx refused real calls, and the app treated a refusal as nothing at all.
- **Measured first.** The vhost had `rate=6r/m burst=5`, written for abuse, not
  for use. On 2026-10-21 that refused `/v1/friends/species` (5×), the token
  refresh (5×) and the shared-species upload (2×). Real traffic is about 130
  `/v1/` calls a day from two phones, and the busiest single second was four
  requests — a phone opens several calls at once when a screen loads, and
  HTTP/2 counts every stream against `limit_conn` (the same trap as #62).
- **Decision:** the vhost is now `rate=60r/m`, `burst=20 nodelay`,
  `limit_conn 10`, with `limit_req_status 429`. That is still far below what a
  flood looks like, and it leaves the API's own limits as the real guard
  (`authByIp` 20 per 10 min, `loginByEmail` 6 per window, `askByIp` 10/min,
  5 code attempts) — those are unchanged, because they protect the mailbox and
  the AI bill, which nginx cannot see. Applied live with `nginx -t` and a
  reload (never a restart); `verify.sh` clean before and after.
- **No silent failures:** `FriendsCache.refresh()` records `lastError` and the
  Species tab shows it under the chips ("The server was busy; friends’ birds
  may be out of date. Trying again…" for a 429, the message itself otherwise),
  and both the refresh and the shared-species upload retry with a backoff
  (`REFRESH_BACKOFF_MS` 2/8/30 s, `UPLOAD_BACKOFF_MS` 3/15/60 s) instead of
  waiting for the next tab open or the next sighting. The cache also refreshes
  when it is created and when the session changes, which is what left a copy
  written *before* a friendship in place for hours.
- **Not done:** no retry loop beyond three attempts (the next tab open or
  sighting retries anyway), and nothing new is sent to the server.

## 65. A browser that cannot run the model is told so before any download; failures name their reason

- **Audit (A5):** the Listen screen started the 78 MB download on every browser,
  and a failed load said only "Couldn't download the bird model. Check your
  open branches.)
- **Check, once, before the first byte:** `checkBrowserSupport()` in
  `src/app/browser-support.ts` runs at the top of `AppController.loadModel()`,
  before `inference.init`, and needs four things: `WebAssembly`, `Worker`,
  `indexedDB` and `AudioContext` (or Safari's `webkitAudioContext`). **WebGL is
  not required**: the worker's backend order is webgl → wasm → cpu, so a phone
  without WebGL still runs the model on WebAssembly, only slower. WebAssembly
  is therefore the one compute requirement; the other three are what the app
  needs around the model (a thread to run it in, a place for sightings, the
  microphone). It is a pure function of the globals, so the tests stub them.
- **Unsupported is its own Listen state** (`ListenStatus` `'unsupported'`,
  pill "Browser not supported"): title "This browser can't run the bird
  model.", hint "It works in current Safari, Chrome, Firefox and Edge." No
  download starts, no toast, and no "Try again", because trying again cannot
  help; the mic and sample-clip buttons are hidden too. Species, Recordings,
  Map and Settings keep working from the bundled label list. The four named
  browsers are the ones whose current versions ship everything on the list.
- **Other failures keep "Try again" and gain a reason line**
  (`describeModelFailure(err)`): no connection (a `TypeError` from fetch, the
  browsers' "Failed to fetch" / "NetworkError…" / "Load failed" messages, or
  `navigator.onLine === false`) → "No connection. The bird model downloads
  once, about 78 MB, so connect to Wi-Fi and try again."; not enough storage
  (an error whose name or message contains "quota") → "Not enough storage.
  The bird model needs about 78 MB free on this phone. Clear some space and
  try again."; anything else keeps the generic text. Storage wins over
  offline, because clearing space is what helps. The worker forwards errors as
  a message string (`src/model/protocol.ts`), so the fetch `TypeError` arrives
  on the main thread as a plain `Error`; the message is matched as well as the
  name. The same sentence is the toast and the Listen hint
  (`AppController.getModelFailure()` → `listenStatus`).
- **Kept small on purpose:** `claude/lazy-model` moves `loadModel()` behind
  "Start identifying"; this change touches only the inside of `loadModel()`,
  so it holds wherever that call ends up.
- **Not done:** no WebGL-vs-WASM speed warning (the pill already shows the
  backend), and no per-reason `UnsupportedReason` wording in the UI (the fix is
  the same for all four: use a current browser); the reason stays in the
  console and the error class.

## 66. Data credits: each source credited where its data is shown (eBird and NatureServe on answers, BirdNET on Listen)


- **Audit finding (AUDIT_PROMPT.md A6/A7):** answers list their sources with
  links (#47), but nothing credited eBird or NatureServe as the terms ask, and
  nothing on the Listen screen said whose model identifies the birds.
- **Terms checked on 2026-10-23.**
  - eBird API Terms of Use, https://www.birds.cornell.edu/home/ebird-api-terms-of-use/
    ("Last edited on October 19, 2021"), section 3 "Attribution": "You agree to
    attribute eBird.org as the source of the data accessed via the API wherever
    it is used or displayed." and "Whenever possible, please accompany this with
    a link back to eBird.org." Section 5: "You agree to maintain all copyright
    or other proprietary notices embedded in or attached to any API Content."
    (The Postman documentation page https://documenter.getpostman.com/view/664302/S1ENwy59
    renders only its title without JavaScript; the terms page above is the one
    it links.)
  - NatureServe: `https://explorer.natureserve.org/AboutTheData/DataTypes/`
    returned 404 (the Explorer is a JavaScript app; its About pages are not
    served as HTML), so the terms were read from the main site.
    https://www.natureserve.org/terms (submitted 05/29/2021): "The copyright
    citation provided at the beginning of this paragraph should be used in any
    published materials which reference the website." and "Specific products
    published by NatureServe may have separate terms of use and citation
    requirements and in those cases, the product specific citation should be
    used." https://www.natureserve.org/data-use-terms-citation (submitted
    11/05/2025): NatureServe Explorer data is CC BY, reuse is allowed "so long
    as attribution is given to the creator", and products built on it "should
    include one of the following citations": "NatureServe. YYYY. NatureServe
    Explorer [web application]. NatureServe, Arlington, Virginia. Available
    https://explorer.natureserve.org/pro/. (Accessed: Month DD, YYYY)."
  - BirdNET: `public/models/birdnet-v2.4/LICENSE.md` (CC BY-NC-SA 4.0, Stefan
    Kahl, Cornell Lab of Ornithology, Chemnitz University of Technology) and
    the existing Help › "Credits and licences" line.
- **Rule (now in DESIGN_GUIDE.md §5 "Source credits"):** a data source is
  credited on every page that displays its data, and on no other page, in the
  small credit style. Listen shows no eBird data, so it carries no eBird text;
  it credits BirdNET, which does the identifying there.
- **Answers (`src/ui/credits.ts`, `src/ui/components/source-credit.ts`,
  `ask-box.ts`):** `creditsFor(sources)` is pure and matches the names the
  server sends (`SOURCE_NAMES` in `server/src/ask.ts`) or the link host. Under
  the answer, after the existing "Sources:" line, one `<p class="answer-credit"
  data-testid="answer-credits">`: "Local sightings in answers: eBird.org"
  (→ https://ebird.org) and/or "Conservation status: NatureServe Explorer"
  (→ https://explorer.natureserve.org), joined with " · ". Wikipedia keeps its
  link in the source line and gets no second credit. An answer from Wikipedia
  alone renders no credit element at all. `font-size: 0.75em` relative to the
  answer paragraph, muted, links underlined and with vertical padding for the
  tap area. The Ask box is the only place an answer renders (species page and
  sighting card both use it), so one component covers both.
- **Listen (`birdnetCredit()`):** "Bird ID: BirdNET, Cornell Lab of Ornithology
  and Chemnitz University of Technology · CC BY-NC-SA 4.0", BirdNET →
  https://birdnet.cornell.edu, the licence → the Creative Commons deed.
  `<p class="source-credit" data-testid="birdnet-credit">`, 12 px, muted,
  centred, the last node in flow in all three layouts; in Bottom dock it comes
  before the fixed dock in the DOM and the layout's `padding-bottom` keeps it
  above the dock, never under it. Wraps at 320 px (`overflow-wrap: anywhere`).
- **Not the full NatureServe citation:** the formal "NatureServe. YYYY. …"
  citation is for published materials; the in-app line names the product and
  links to it, which satisfies CC BY attribution, and the server's source line
  already links the species record. The formal citation can be added to Help
  if NatureServe asks.
- **CSP:** the three new links are navigations (`target="_blank"`), not
  fetches, so `connect-src` is untouched; `vercel.json` has `form-action
  'self'` and no `navigate-to`, neither of which restricts links.
- **Tests:** `tests/credits.test.ts` (eBird only, NatureServe only, both,
  neither, host matching); e2e: the BirdNET credit is inside the viewport and
  clear of the dock and tab bar in all three layouts at 320 px with no "eBird"
  text on Listen; a stubbed answer with eBird in `sources` shows the credit
  with the right link, one with NatureServe only shows only that, one with
  Wikipedia only shows none.
