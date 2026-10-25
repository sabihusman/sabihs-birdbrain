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
  The model loads on demand (`ensureModel()`, DECISIONS.md #69): `init()` loads
  only the species list, plus the model when `src/app/first-visit.ts` says the
  phone asked for it before (cached, or the `birdbrain.model.v1` flag). A first
  visit shows the welcome layer (`src/ui/components/welcome.ts`, #65) and nothing
  downloads until an identifying action.
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
  `src/species/wiki.ts` — Wikipedia REST summary with IndexedDB cache;
  `src/species/wiki-sections.ts` — Description / Song / Habitat / Diet
  excerpts from the full article via TextExtracts (same request as the
  server, plus `origin=*`), cached in the same `wiki` store.
- Sighting card (`src/ui/views/recordings.ts`, `recordingDetailView`): title
  = top species, `src/ui/components/map-preview.ts` (non-interactive Leaflet
  preview, "Tap to explore") above `location-block.ts` (Plus Code folded under
  "More location details"), confidence as text (`src/ui/confidence-text.ts`),
  `about-bird.ts` (summary + sections, also used by the species page) and
  `ask-box.ts` for members. See DECISIONS.md #46.
- `src/export/` — CSV / GeoJSON.
- Map tab (`src/ui/views/map.ts`): map, then a Birds | Places switch
  (`mapCardsView` setting) and cards. Places are 1 km-diameter areas
  (`src/geo/areas.ts`, leader clustering, centres ≥ 1 km apart) named by
  OpenStreetMap's Nominatim reverse geocoder (`src/geo/geocode.ts`: 1.1 s serial
  queue, `geocode:` entries in the `wiki` store, 180 days, `VITE_GEOCODER_URL`),
  only while Places is open. See DECISIONS.md #73 (Overpass, #72, is gone).
- Member-only, on-device: `src/app/access.ts` (gating from the cached
  session), `src/species/clips.ts` (one raw clip per species, replace-if-higher,
  10 s cap), `src/ui/components/{member-gate,species-id-card,clip-player}.ts`,
  `src/ui/views/species-history.ts` (list + `leaflet.heat` / pins map). DB
  version 2 adds the `clips` store. See DECISIONS.md #27–29.
- `src/api/client.ts` — bearer-token client for the API (`src/api/config.ts`
  holds the base URL from `VITE_API_BASE_URL`); `src/ui/views/account.ts`,
  `admin.ts`, `src/ui/components/ask-box.ts`, `location-block.ts`,
  `src/geo/pluscode.ts`, `src/audio/import-cap.ts`. `admin.ts` holds two
  admin-only pages: `#/admin/users` (User management: approve, send reset link,
  delete; the only entry is Settings › Account › "Manage users") and `#/admin`
  (Ask costs). See DECISIONS.md #61. Account pages (`src/ui/views/auth.ts`):
  `#/signin`, `#/signup` (code at sign-up, "Waiting for approval", #77),
  `#/forgot-password` and `#/reset-password?token=` (emailed one-use link,
  `server/src/password-reset.ts`, token hashed at rest, #78). My account
  (`#/account`, `accountView` in `src/ui/views/account.ts`, #79): password,
  sharing, friends with a "Share with <name>" switch each (`friendship.a_shares`
  / `b_shares`); the Settings card is a summary that links there. Invites to an
  address with no account (`server/src/email-invites.ts`, #80) mail a
  `#/signup?invite=` link; approval makes the two friends.

Back end (`server/`, TypeScript, Hono + Better Auth + `node:sqlite`):

- `src/app.ts` routes; `src/auth.ts` Better Auth options (bearer plugin,
  `status`/`role` user fields, admin via `ADMIN_EMAIL`); `src/login-codes.ts`
  the email second factor; `src/ask.ts` the Gemini pipeline and caps;
  `src/wiki-article.ts`, `src/natureserve.ts`, `src/ebird.ts` the three
  fetched, cached sources (`EBIRD_API_KEY` optional; DECISIONS #47);
  `src/context-select.ts` (Wikipedia sections relevant to the question, the
  whole fenced source ~1,500 tokens), `src/answer-cache.ts` (same species +
  region + position + question → 7-day reuse), `src/pricing.ts` (list prices
  and thinking level per model, verified dates in the comment) and
  `src/ask-cost.ts` (per-day token/cost totals, `GET /v1/admin/ask-costs`;
  DECISIONS #48); `src/users.ts` admin SQL; `src/account-deletion.ts` the
  one-transaction account wipe (DECISIONS.md #50); `src/backup.ts`
  `VACUUM INTO` backups.
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
- AI providers for `/v1/ask` (DECISIONS.md #49): `src/providers/ollama.ts`
  (Ollama Cloud, `POST https://ollama.com/api/chat`, plain `fetch` with an
  `AbortController` timeout), `src/providers/gemini.ts` (the existing wrapper
  behind the provider interface), `src/providers/index.ts` (the chain:
  `AI_PROVIDER_ORDER`, default `ollama,gemini`, fallback on any failure,
  empty or cut-off answer; one `[ask] provider=… fallback_from=…` line per
  request). `src/provider-usage.ts` keeps per-provider daily totals
  (`ask_provider_usage`) shown on the admin cost summary. The live `.env`
  sets `OLLAMA_MODEL` and `GEMINI_MODEL`; never hardcode model names.
  `GET /v1/ai-services` lists the configured services by company name (`PROVIDER_LABELS`); the app's
  privacy text and How it works name them from it (`src/api/ai-services.ts`, DECISIONS.md #90).
  `src/providers/anthropic.ts` (DECISIONS.md #91): Claude through `@anthropic-ai/sdk` (pinned),
  `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` (no default) + `ANTHROPIC_TIMEOUT_MS`, name `anthropic` in
  `AI_PROVIDER_ORDER`; effort low, no SDK retry, refusal = fall back. List prices for the admin
  estimate in `src/pricing.ts` (`ANTHROPIC_PRICES`, verified date in the comment). Tests:
  `test/anthropic-provider.test.ts` (fake client, never the real API).
  Tests: `test/fake-ollama.ts`, `test/providers.test.ts`,
  `test/adversarial-ollama.test.ts`, `test/provider-usage.test.ts`.
  `docs/LIVE_HARDENING.md` is the checklist to run against the live server.
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
models/birdnet-v2.4/          BirdNET TF.js weights (CC BY-NC-SA 4.0, ~78 MiB, 23 files) + SHA256SUMS.
                              NOT served by Vercel: scripts/server/publish-model.sh copies them to
                              /opt/birdbrain/models/ and Nginx serves them (DECISIONS.md #56).
public/models/birdnet-v2.4/   labels.json (precached for the offline list) + LICENSE.md
public/samples/               3 s sample clip from the BirdNET repo (demo + e2e)
public/worklet/               AudioWorklet processor (plain JS, served as-is)
public/icons/, *.png          PWA icons (generated by scripts/make-icons.ts)
src/                          app code (TypeScript, no framework)
tests/                        Vitest unit tests (node environment, fake-indexeddb)
e2e/                          Playwright test (Chromium, iPhone viewport)
scripts/                      validate-model.ts (Node check of the model), make-icons.ts, screenshots.ts
                              (the model eval lives in server/scripts/eval-models.ts: `cd server && npm run eval`)
scripts/server/               update-planner.sh, backup-restore-test.sh (run by hand on the host, read-only; test.sh; docs/SERVER_RUNBOOK.md)
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
cd server && npm run eval -- --dry-run   # plan only; with GEMINI_API_KEY set it runs (refuses above $0.10)
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
  runtime-cached on first use (cache `birdnet-models-v2.4`), and come from
  `https://bird-brain.duckdns.org/models/birdnet-v2.4/`, not from Vercel
  (`src/model/model-source.ts`, `VITE_MODEL_BASE_URL`). `npm run dev` and
  `npm run preview` serve the repository's `models/` folder themselves
  (`scripts/serve-models.mts`); a local `npm run build` for a preview needs
  `VITE_MODEL_BASE_URL=/models/birdnet-v2.4/`, which is what CI uses.
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
