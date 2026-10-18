# Build Spec: Sabih's Birdbrain (PWA)

You are running in a Claude Code cloud session. The repo `sabihs-birdbrain` has already been created on GitHub, contains only a README and this file, and is cloned into your working directory. Read this entire file before acting.

## Naming

- Display name: "Sabih's Birdbrain". Use it for the page title, the manifest `name`, the in-app header, and the README title. Use a typographic apostrophe (’) in visible text.
- Short name: "Birdbrain". Use it for the manifest `short_name` and `apple-mobile-web-app-title`, so the home-screen label isn't cut off.
- Repo and package name: `sabihs-birdbrain`.

## Operating rules

- Work fully autonomously. Do not ask me questions. When a choice is ambiguous, pick the most reasonable option, log it in `DECISIONS.md` (decision, alternatives, reason), and continue.
- Build in the PHASES below, in order. Each phase ends with passing tests, a commit, and a push to your working branch, so the branch works at every checkpoint.
- If a later phase fails after reasonable attempts, keep the work from earlier phases, document the failure in `DECISIONS.md`, and move on.
- Never invent library APIs. Check package docs or type definitions before using a method you are unsure of.
- Never commit secrets. This project needs none.
- Move this file into the repo as `docs/BUILD_SPEC.md`.

### Stop conditions (the only times you stop and report back)

1. Step 0 finds a missing tool you cannot install, or the network blocks something the build cannot work around.
2. You cannot obtain BirdNET model files that run in the browser with a license allowing this use.

## Step 0: Environment check

- This is a Linux cloud VM with the repo already cloned. Do not run `git init`, and do not try to create repos or change GitHub settings.
- Check `node --version` (LTS 20 or newer), `npm --version`, and `git --version`. Report the versions.
- Network access may be restricted. If a needed domain is blocked, find an alternative source (prefer GitHub). If there is none, record what was blocked in `DECISIONS.md`, skip that step, and continue.
- Note: Cornell's demo site and Wikipedia may be unreachable from this VM. That's fine: the app calls Wikipedia from the user's browser, not from the VM.

## Step 1: Research (before writing any code)

- Find the official BirdNET browser model (TensorFlow.js), its species label list, and the BirdNET location/season ("geo") model. Source them from the official birdnet-team GitHub repos (Cornell's demo site may be blocked from this VM).
- Read the licenses of the models and of any code you consider reusing. The models are expected to be CC BY-NC-SA 4.0; confirm this.
- Use BirdNET Live (the birdnet-team real-time PWA) as a reference only. Do not copy its code unless its license permits it, and credit it if you do.
- Determine:
  - the model's expected input (sample rate, window length)
  - whether it takes raw audio and builds its spectrogram internally
  - its output format
  - the geo model's inputs
  - the total model download size
- Record every source, version, and license in `docs/SOURCES.md`.

## Stack

- Vite + TypeScript, no UI framework unless clearly justified (log the reason if you add one).
- TensorFlow.js running in the browser, inside a Web Worker so the UI stays smooth.
- Leaflet with OpenStreetMap tiles for maps.
- IndexedDB for storage.
- No backend. Audio never leaves the device.

## Phase 1: Core identification

1. A Start/Stop button for continuous listening. Microphone access and the AudioContext must start from this tap (an iOS requirement).
2. Audio pipeline: microphone, then an AudioWorklet, then mono audio resampled to the model's rate (expected 48 kHz), then windows of the model's length (expected 3 seconds) with overlap, then the model.
3. Multi-species output: the model can flag several species in one window. Show every species above the threshold, with its confidence.
4. A confidence threshold slider, saved locally.
5. Location filtering: use the Geolocation API plus the current week of the year with the geo model. Fall back to manual latitude/longitude entry, or no filter, if location is denied.
6. Continuous mode:
   - Keep the screen awake with the Screen Wake Lock API while listening, and show a notice if it isn't supported.
   - Resume the AudioContext when the app returns to the foreground.
   - Show elapsed session time.
7. A species color system: assign each species a fixed, distinct color (stable across sessions, readable in light and dark mode). Always show the species name next to its color; never rely on color alone.

## Phase 2: Visualization ("how it works")

1. A live waveform and a scrolling spectrogram, drawn on a canvas with your own FFT. If the model builds its own spectrogram internally, label yours as an approximation of what the model sees.
2. Overlay the analysis window sliding across the spectrogram, and shade each analyzed window with the colors of the species detected in it.
3. A per-species confidence timeline (one colored line per species) below the spectrogram.
4. A "How it works" pipeline view: Microphone, then Resample, then Window, then Spectrogram, then Neural network, then Location/season filter, then Result.
   - Each stage lights up as audio moves through it.
   - Give each stage a one-line plain-English explanation.
5. In the README and the in-app help, state honestly that BirdNET marks *when* each species is present but does not separate overlapping calls.

## Phase 3: Recording and re-analysis

1. A Record button, usable alongside or apart from listening. Save the raw audio as WAV from the AudioWorklet stream, not MediaRecorder.
2. A recordings library: play back, re-analyze with the full visualization, delete, export WAV. Also allow importing audio files for analysis.
3. Optional auto-save of a short clip around each detection, controlled by a setting.
4. Storage:
   - Show storage used versus available.
   - Call `navigator.storage.persist()` and report the result in settings.
   - Note in `DECISIONS.md` that iOS may still clear stored data.
5. "Why this ID" heatmap, for saved recordings only:
   - Run occlusion analysis: mask time-frequency regions, re-run the model, and show which regions changed confidence most.
   - Draw it over the spectrogram in the species' color.
   - Run it in the worker with a progress bar and a cancel button.
   - If it's too slow on mobile, reduce the resolution and document the tradeoff.

## Phase 4: Species lookup

1. A searchable species browser built from the BirdNET label list (common and scientific names). It must work offline.
2. A species detail page showing the Wikipedia summary: description, thumbnail, and a link to the full article.
   - Use the Wikipedia REST summary endpoint (`/api/rest_v1/page/summary/{title}`), looking species up by scientific name first.
   - Handle disambiguation and not-found results.
   - Before relying on them, verify the endpoint, its CORS behavior, and whether the `Api-User-Agent` header is allowed from a browser.
   - Cache viewed summaries for offline use.
   - Show image attribution and a link to the image's file page.
3. Also show my own detections of that species: count, first and last seen, a mini map, and links to the matching recordings.
4. Tapping a species anywhere in the app (live results, history, map) opens its page.

## Phase 5: Geo tagging and map

1. Store each detection with latitude, longitude, location accuracy, timestamp, confidence, and a recording link if one exists.
2. A map view:
   - Markers in each species' color, clustering when zoomed out.
   - Filters by species and date range.
   - Tapping a marker opens the species page.
3. Export detections as CSV and GeoJSON.
4. Follow the OpenStreetMap tile usage policy: show attribution, and do not bulk-prefetch or cache tiles in the service worker.

## Across all phases

- PWA basics:
  - manifest, icons, and apple-touch-icon
  - a service worker that caches the app shell and model files (not map tiles) for offline use
  - model-loading progress shown on first run
- iOS Safari:
  - The microphone needs HTTPS and a user gesture.
  - Handle permission states (granted, prompt, denied) with clear messages. Home-screen mode may re-ask for permission.
- Design mobile-first for iPhone portrait:
  - Respect safe areas and support light and dark mode.
  - Use large tap targets.
  - Use bottom tab navigation: Listen, Recordings, Species, Map, Settings.

## Quality

- Vitest unit tests for:
  - resampling and windowing
  - threshold and multi-label logic
  - week-of-year calculation
  - species color assignment
  - WAV encoding
  - CSV and GeoJSON export
- A Playwright test (if its browser binaries can't be installed on this VM, skip it and say so) that loads the built app, confirms the model loads, and runs inference on a sample recording from the official BirdNET repos if one exists. If none exists, skip that check and say so in the final report.
- Lint, typecheck, and tests run in GitHub Actions CI.

## Repo and deploy

- The repo already exists, and GitHub Pages is already set to deploy from GitHub Actions. Do not try to change either.
- Add a GitHub Actions workflow that builds the app and deploys it to GitHub Pages on every push to `main`.
- Set Vite's base path to `/sabihs-birdbrain/`.
- You can only push to your working branch. Push there; I'll merge it to `main` myself, which triggers the deploy.
- Before finishing, run `npm run build` and serve `dist/` locally with `npm run preview` to confirm the built app starts.

## Documentation

- `README.md`, written as a portfolio piece:
  - the problem
  - a Mermaid pipeline diagram
  - screenshots taken with Playwright at iPhone size
  - privacy (on-device processing)
  - known limitations: no background listening, no separation of overlapping calls, iOS quirks, accuracy limits
  - the V2 plan (a native iOS app)
- Licensing in the README: the BirdNET models are non-commercial (CC BY-NC-SA 4.0). License the app code MIT, and state clearly that the model files carry their own license, with full model credit.
- `CLAUDE.md` for future sessions:
  - architecture overview and folder map
  - how to run, test, and deploy
  - key decisions and known issues
  - the V2 native-iOS plan

## Final report (print when done)

- The branch name, and the expected live URL after I merge: `https://<github-username>.github.io/sabihs-birdbrain/`.
- Phases completed, and anything skipped or degraded.
- What you verified, and what you could not.
- The contents of `DECISIONS.md`.
- A checklist for me to test on my iPhone:
  - open in Safari and add to the Home Screen
  - grant microphone access and test outdoors
  - record, then re-analyze
  - open a species page
  - check the map
  - test offline
