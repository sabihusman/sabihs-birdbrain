# CLAUDE.md — notes for future sessions

Sabih’s Birdbrain is a mobile-first PWA that identifies bird sounds on-device
with BirdNET V2.4 running in TensorFlow.js inside a Web Worker. Audio never
leaves the phone. Front end on Vercel at `https://sabihs-birdbrain.vercel.app`
(base path `/`; verified live with the strict CSP on 2026-10-19; the former
GitHub Pages site was switched off the same day). Optional back end (`server/`) at
`https://bird-brain.duckdns.org`: accounts with an emailed login code, admin
approval, and member-only "Ask about this bird" answered by Gemini from the
Wikipedia summary.

## Architecture

```
Microphone ─► AudioWorklet (public/worklet/capture-processor.js, mono batches)
          ─► AudioEngine (src/audio/engine.ts): resample to 48 kHz, Windower (3 s, overlap)
          ─► AppController (src/app/controller.ts): orchestrates everything below
          ─► InferenceClient (src/model/worker-client.ts) ⇄ inference.worker.ts
                 worker: TF.js backend (webgl→wasm→cpu), MelSpecLayerSimple (our JS STFT),
                 acoustic Layers model, geo Graph model, occlusion analysis
          ─► rankScores / selectDetections (src/model/postprocess.ts)
          ─► IndexedDB (src/storage/db.ts: recordings, detections, wiki cache)
          ─► UI views (src/ui/views/*), canvas visualisations (src/ui/viz/*)
```

Key modules:

- `src/model/melspec-layer.ts` — re-implementation of BirdNET's custom Keras
  layer. The STFT is done in plain JS (`src/audio/fft.ts`, `stft.ts`) using the
  **real part** of the spectrum (what the official export does). Do not switch
  to magnitude: it degrades results (see DECISIONS.md #2).
- `src/model/inference.worker.ts` — all TF.js work. Message protocol in
  `src/model/protocol.ts`. Jobs are serialised; `cancel` is handled out of band.
- `src/app/controller.ts` — session state, persistence, wake lock, visibility,
  auto-save clips, demo clip. Views subscribe to its events.
  `prepareForAnalysis()` applies the low-cut to clips before inference.
- `src/audio/engine.ts` — two worklet taps: raw (recording, viz, conditions)
  and analysis (through a 150 Hz `BiquadFilterNode` when `lowCut` is on).
  Saved audio is always raw. `src/audio/mic-constraints.ts` classifies
  `track.getSettings()` into the "Voice processing" status; `highpass.ts`,
  `conditions.ts`, `ring-buffer.ts` hold the filter, the indicator thresholds
  and the raw sample ring (see DECISIONS.md #24–26).
- `src/app/settings.ts` — localStorage settings; `src/app/location.ts` — GPS /
  manual / off and BirdNET week (`src/model/geo.ts`).
- `src/ui/app.ts` — shell, hash router (`src/ui/router.ts`), bottom tabs.
- `src/species/colors.ts` — deterministic OKLCH species colours;
  `src/species/wiki.ts` — Wikipedia REST summary with IndexedDB cache.
- `src/export/` — CSV / GeoJSON.
- Member-only, on-device: `src/app/access.ts` (gating from the cached
  session), `src/species/clips.ts` (one raw clip per species, replace-if-higher,
  10 s cap), `src/ui/components/{member-gate,species-id-card,clip-player}.ts`,
  `src/ui/views/species-history.ts` (list + `leaflet.heat` / pins map). DB
  version 2 adds the `clips` store. See DECISIONS.md #27–29.
- `src/api/client.ts` — bearer-token client for the API (`src/api/config.ts`
  holds the base URL from `VITE_API_BASE_URL`); `src/ui/views/account.ts`,
  `admin.ts`, `src/ui/components/ask-box.ts`, `location-block.ts`,
  `src/geo/pluscode.ts`, `src/audio/import-cap.ts`.

Back end (`server/`, TypeScript, Hono + Better Auth + `node:sqlite`):

- `src/app.ts` routes; `src/auth.ts` Better Auth options (bearer plugin,
  `status`/`role` user fields, admin via `ADMIN_EMAIL`); `src/login-codes.ts`
  the email second factor; `src/ask.ts` the Gemini pipeline and caps;
  `src/wiki-article.ts`, `src/natureserve.ts`, `src/ebird.ts` the three
  fetched, cached sources (`EBIRD_API_KEY` optional; DECISIONS #47);
  `src/users.ts` admin SQL; `src/backup.ts` `VACUUM INTO` backups.
- Migrations: `migrateAuth(db, config)` must run **before** `createAuth` or
  Better Auth logs a schema mismatch.
- Tests: `cd server && npm test` (Vitest, in-memory SQLite, `FakeMailer`).
- Image: `server/Dockerfile` (context = repo root, copies `labels.json`),
  built by `.github/workflows/server-image.yml` to
  `ghcr.io/sabihusman/birdbrain-api`; `server/compose.yml` is the hardened
  production compose file; `server/deploy/` holds the server install kit
  (`setup.sh` numbered steps with `--dry-run`, `rollback.sh`, `verify.sh`,
  Nginx site files, lego renew units, forced-command deploy user files; see
  `server/deploy/README.md`). Env variable names: `server/.env.example`.
  Default Gemini model: `gemini-3.8-flash` (`GEMINI_MODEL`).
- Server state (installed 2026-10-19 with `setup.sh` steps 1-8 on 95.216.159.93,
  which also hosts other projects that must never be touched; see
  `server/deploy/README.md`): `/opt/birdbrain/.env` sets `BIRDBRAIN_IMAGE_TAG=latest`,
  so every push to `main` that touches `server/` rebuilds the image and the CI
  deploy job redeploys it through the forced command; pin a `sha-<commit>` tag
  there to roll back. The Nginx vhost has **no** `http2` listen flag (nginx 1.24
  sets HTTP/2 per socket and the mba-vault catch-all already enables it; the
  flag only made `nginx -t` warn). `~birdbrain-deploy/.ssh` and its
  `authorized_keys` are root-owned. `server/deploy/verify.sh check` is the
  acceptance test: other sites unchanged, `/health` 200, 8010 loopback-only.

Folder map:

```
server/                       API (see above); server/deploy/ server-side install files
vercel.json                   Vercel headers (strict CSP) and build settings; .env.example front-end vars
public/models/birdnet-v2.4/   BirdNET TF.js export (CC BY-NC-SA 4.0, ~78 MiB) + labels.json
public/samples/               3 s sample clip from the BirdNET repo (demo + e2e)
public/worklet/               AudioWorklet processor (plain JS, served as-is)
public/icons/, *.png          PWA icons (generated by scripts/make-icons.ts)
src/                          app code (TypeScript, no framework)
tests/                        Vitest unit tests (node environment, fake-indexeddb)
e2e/                          Playwright test (Chromium, iPhone viewport)
scripts/                      validate-model.ts (Node check of the model), make-icons.ts, screenshots.ts
docs/                         BUILD_SPEC.md (original brief), SOURCES.md, screenshots/
```

## Run, test, deploy

```
npm install
npm run dev          # http://localhost:5173/
npm run typecheck    # tsconfig.json (DOM) + tsconfig.worker.json (WebWorker lib)
npm run lint
npm test             # vitest
npm run build        # typecheck + vite build → dist/ (includes sw.js)
npm run preview      # serve dist/ at http://localhost:4173/
npm run test:e2e     # playwright (starts preview itself); needs Chromium installed
npx tsx scripts/validate-model.ts <modelDir> real <file.wav> [windows]   # Node sanity check
```

Deploy: Vercel builds from the repo with base `/` (Sabih connected it); the
GitHub Pages workflow is gone (Pages switched off 2026-10-19). `VITE_BASE_PATH`
remains as a generic override for serving under a sub-path. `ci.yml` runs lint, typecheck, unit tests,
build and the e2e test on every push. `server-image.yml` tests the API, pushes
the image to GHCR, and on `main` triggers the server's forced-command deploy
over SSH (secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`). The CSP in
`vercel.json` lists the API host; `scripts/csp-check.mts` serves the build with
those headers and fails on any violation.

## Key decisions and known issues

See DECISIONS.md for the full list. The ones that bite:

- WebGL in a Worker on Safari: TF.js refuses `OffscreenCanvas` when
  `IS_SAFARI` is true; the worker overrides that flag and disables the fence
  API. If iOS still fails, the WASM backend takes over automatically (slower,
  ~1-3 s per window on recent iPhones is the expectation, unverified).
- Windows that arrive while inference is busy are skipped (counted in the UI),
  so slow devices degrade gracefully.
- iOS stops web audio in the background and may clear site storage; the app
  keeps the screen awake with the Wake Lock API while listening and says so.
- The occlusion "Why this ID" is 25–97 model passes; keep it on saved
  recordings only.
- The three TF.js WASM binaries are precached (~1.2 MB); model shards are
  runtime-cached on first use (cache `birdnet-models-v2.4`).
- Playwright here runs Chromium only; iOS behaviour must be tested on a device.
- `el()` sets styles through `style.cssText` (CSSOM), never the `style`
  attribute, because the CSP has no `'unsafe-inline'`. Keep it that way.
- Changing the API domain later: `VITE_API_BASE_URL` (or the default in
  `src/api/config.ts`), the `connect-src` in `vercel.json`, and on the server
  `ALLOWED_ORIGINS`, `BETTER_AUTH_URL`, `MAIL_FROM`.

## V2 plan: native iOS app

- Swift/SwiftUI app with AVAudioEngine capture and Core ML / TensorFlow Lite
  for BirdNET (the official TFLite FP16/INT8 models exist), running in the
  background with the `audio` background mode, which the web app cannot do.
- Keep the same data model (recordings, detections, species) and import the
  PWA's CSV/GeoJSON exports.
- Use the Neural Engine via Core ML for ~10x faster inference and lower
  battery use; MapKit instead of Leaflet; Wikipedia summaries via the same
  REST endpoint.
- Share the species-colour function and week formula so colours and seasonal
  filtering match the web app.
