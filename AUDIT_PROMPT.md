# Birdbrain audit fixes — work prompt

Paste this into a Claude Code session on `sabihusman/sabihs-birdbrain`.
Sabih's decisions are filled in below (2026-10-22).

## Context: what the audit got right and wrong

Checked against the code on `main` (2026-10-22):

| Audit claim | Verdict | Evidence |
|---|---|---|
| Every page, including login, sits behind the model download | **Partly wrong.** The tabs and Settings › Account render while the model loads. But the app opens on Listen, whose whole screen is the "Loading the model" state, and nothing tells a visitor the other tabs work. | `controller.init()` → `loadModel()` on every start (`src/app/controller.ts`); Listen `STATE_TEXT.loading` (`src/ui/views/listen.ts`). |
| A new device downloads 78 MB just to log in | **Right.** The download starts on every first visit, whatever the visitor came to do. | Same `init()` path; no user action needed. |
| No progress signal | **Partly wrong.** The header pill shows "Loading model N%". The big Listen panel shows no percent and there is no cancel. | Worker `progress` messages; pill in `src/ui/app.ts`. |
| HTML has no description | **Partly wrong.** A `<meta name="description">` exists. There are no Open Graph tags and no static body text, so link previews and no-JS readers see nothing. | `index.html`. |
| No error path / WebGPU requirement | **Mostly wrong.** A failed download shows a message and "Try again". The app uses WebGL → WASM → CPU, not WebGPU. There is no "this browser can't run it" note. | `MODEL_DOWNLOAD_ERROR`, Listen error state. |
| eBird attribution unverifiable | **Fair.** Answers list their sources with links (#47), but nothing public credits eBird or NatureServe. | `src/ui/components/ask-box.ts`. |

## Actions

Do them in this order, one PR each, from `main`. Each needs tests, CI and SonarCloud green, then stop for review (do not merge).

### A1. Welcome layer before the download (audit 1, 2)
- First visit (no settings stored, no cached model): show a short welcome screen instead of the loading state: what Birdbrain does in one sentence, that identification runs on the phone and needs a one-time ~78 MB download, that accounts are optional and approved by Sabih, and two buttons: **"Start identifying"** (starts the download) and **"Sign in / Create account"** (opens Settings › Account without downloading).
- Returning visitors with the model cached skip it.
- **DECISION A1-trigger: (a)** the download starts only when the visitor taps "Start identifying" (or Listen's start, an import, or the demo clip). Nothing downloads on its own.
- **DECISION A1-copy: (a)** Claude drafts in Sabih's voice (see "Writing style" below); Sabih edits in the PR.

### A2. Model loads only when needed (audit 2)
- Move `loadModel()` out of `controller.init()`: start it from Listen's start action, a recording import, the demo clip, or "Start identifying". Species list, Account, Map, Recordings and Settings must work with no model.
- Keep the service-worker cache: once downloaded, later visits load from the phone.
- Tests: Settings › Account sign-in reachable and usable with model requests blocked; no request to the model host until an identifying action.

### A3. Progress and cancel on the Listen panel (audit 3)
- Show "Downloading 34 MB of 78 MB" and a progress bar in the big panel, not only the header pill; the "Choosing compute backend" step gets plain words ("Preparing the model on this phone…").
- **DECISION A3-cancel: (b)** no Cancel; progress only. The existing "Try again" covers failed downloads.

### A4. Shell text and link previews (audit 4)
- Add Open Graph and Twitter card tags (title, description, a 1200×630 preview image from the existing icon art) and a short static paragraph inside `#app` that the app replaces on start (also a `<noscript>` line).
- **DECISION A4-image: (a)** generate a 1200×630 preview image from the app icon and name (`scripts/make-icons.ts` style), both themes not needed: use the dark Forest Night colours.

### A5. Browser-support and failure copy (audit 6)
- Before downloading, check for WebGL or WebAssembly; if neither, say plainly which browsers work (current Safari, Chrome, Firefox, Edge) instead of starting a download that cannot run.
- Keep the existing "Try again" path; add the reason class in plain words (no connection / not enough storage / browser not supported).

### A6. Data credits (audit 5)
- Verify against the official eBird API terms and NatureServe terms (fetch the pages, quote the attribution requirement in DECISIONS.md) what credit is required and where.
- Every answer that used eBird or NatureServe shows a credit line with a link, e.g. "Sightings data: eBird.org · Status: NatureServe Explorer".
- **DECISION A6-placement: (a)** credits appear only on answers that used that source. The credit line is **25% smaller than the answer text** (`font-size: 0.75em` relative to the answer paragraph), still readable and with working links.

### A7. Credit each source where its data is shown: eBird on answers, BirdNET on Listen (Sabih's decision)
- No eBird credit on Listen or any other page that does not display eBird data. Listen identifies birds with BirdNET and shows no eBird data.
- **Listen credits BirdNET instead** (it is BirdNET's model that identifies the birds there): one line at the bottom of the Listen screen in all three layouts (Consolidated, Bottom dock, Focus): "Bird ID: BirdNET, Cornell Lab of Ornithology and Chemnitz University of Technology" with "BirdNET" linking to https://birdnet.cornell.edu and a short "CC BY-NC-SA 4.0" link to https://creativecommons.org/licenses/by-nc-sa/4.0/. The names and licence match `public/models/birdnet-v2.4/LICENSE.md` and the existing credit on the Help page. Same size as A6 credits (small, muted, never larger than body text); clear of the dock and tab bar at 320 px in both themes.
- Today the only place eBird data appears is an "Ask about this bird" answer that used it (species page and sighting card). There, the A6 credit line applies: "Local sightings in answers: eBird.org" (link to https://ebird.org), at 75% of the answer's text size, shown only when that answer's sources include eBird.
- If a later feature shows eBird data anywhere else (a list, map or chart), it carries the same credit on that page. Add a short rule to `docs/DESIGN_GUIDE.md` saying so.
- Tests: the eBird credit renders for an answer whose `sources` include eBird and is absent otherwise; no eBird text appears on Listen in any layout; the BirdNET credit is visible and inside the viewport on Listen in all three layouts at 320 px.

## Writing style (for A1 and any new UI text)

Taken from Sabih's own writing in the MBA vault (Individual Reflection, Maximizing Team Performance). Match it:
- First person where it fits, direct and confident, but measured ("I'd like to think…").
- Short, plain sentences; one idea each; no hype words, no exclamation marks.
- States the purpose, then the practical consequence (what it means for the reader).
- Professional but warm; light business vocabulary is fine, jargon is not.
- Example of the target register for the welcome screen (draft, to be edited by Sabih):
  "Birdbrain listens and tells you which birds are singing. It runs on your phone, so your audio never leaves it. The first time, it downloads a 78 MB bird model. Use Wi-Fi if you can. An account is optional. It adds Ask about this bird and sharing with friends, and I approve each new one."

Note: the vault holds little informal writing by Sabih (most discussion posts there are classmates'), so treat the style notes as a starting point and expect edits.

## Rules for the session
- Plain-language UI text; works at 320–430 px in both themes; follow `docs/DESIGN_GUIDE.md`; `el()` sets styles only through cssText (CSP has no `'unsafe-inline'`).
- No new external hosts unless the CSP in `vercel.json` is updated in the same PR and `scripts/csp-check.mts` passes.
- Never hardcode model names; members-only features stay members-only.
- Write each choice made without asking into DECISIONS.md.
