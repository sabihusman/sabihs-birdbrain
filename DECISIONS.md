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

## 37. Theme system per docs/DESIGN_GUIDE.md (dark by default)

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

