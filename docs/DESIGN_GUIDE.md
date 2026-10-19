# Sabih's Birdbrain: Design Guide

Version 1.0 · October 2026 · Owner: Sabih

This guide is the reference for the look, feel and behaviour of Sabih's Birdbrain. Store it in the repo as `docs/DESIGN_GUIDE.md`. When code and this guide disagree, follow the guide and record the change in `DECISIONS.md`. Hex values are starting points. If a value fails a contrast check, change the token, never a species colour, and record why.

---

## 1. What the app is

Birdbrain is a **live microphone bird identifier**, not a library of recorded sounds. The user points the phone at a sound, the app names the bird on the device, and saves sightings locally. Every design choice serves that moment: start fast, read the result at arm's length, trust what you see.

## 2. Principles

1. **One main action per screen.** On Listen it is Start/Stop. No other filled button competes with it.
2. **The bird first, the interface second.** Photo, then name, then confidence. Technical detail comes later.
3. **Show detail only on request.** The waveform, spectrogram, pipeline and confidence timeline sit in a collapsed "How it works" section. They never open on their own.
4. **Status in words.** Every state has text and an icon. Colour is never the only signal.
5. **Calm by default, focused while listening.** The listening area becomes a distinct, darker panel only while the mic is on.
6. **Honest about uncertainty.** Always show confidence. Never hide that results are guesses.
7. **Privacy is visible.** Say where data lives ("Kept on this device only") wherever recordings or locations appear.

## 3. Themes

There are two themes. **Dark is the default**, whatever the phone's own light/dark setting.

### 3.1 Theme toggle
- A small sun/moon icon button at the very top of every screen, right side of the header.
- Tap target at least 44×44 px, an `aria-label` ("Switch to light mode" / "Switch to dark mode"), and a visible focus ring.
- The choice is remembered on the device (wrap the storage call in try/catch, and fall back to dark).
- The theme is applied **before first paint** (a tiny inline script in `<head>`), so the wrong theme never flashes.

### 3.2 Dark theme: "Forest Night" (default)

| Token | Value | Use |
|---|---|---|
| `--page` | `#121A17` | Page background |
| `--panel` | `#1C2A25` | Listening panel, dock |
| `--card` | `#1A2420` | Cards |
| `--line` | `#2A3833` | Borders, dividers |
| `--text` | `#E4EDE8` | Body text |
| `--muted` | `#93A39C` | Secondary text |
| `--accent` | `#5FCB97` | Primary button, active tab, live meter |
| `--on-accent` | `#0B1F16` | Text on accent |
| `--ok` | `#5FCB97` | "Good" conditions |
| `--warn` | `#E8B36A` | Warnings, "Windy", "Too quiet" |
| `--error` | `#E07A5F` | Errors, mic blocked |
| `--focus` | `#E8B36A` | Focus ring (3 px) |

### 3.3 Light theme: "Field Guide, cream"

| Token | Value | Use |
|---|---|---|
| `--page` | `#F4ECDA` | Page background (cream, never white) |
| `--card` | `#FBF6EC` | Cards (lighter cream) |
| `--panel` | `#2F5A48` | Listening panel, dock (forest) |
| `--on-panel` | `#F8F3E6` | Text on panel |
| `--line` | `#E3D9C2` | Borders |
| `--text` | `#24302A` | Body text |
| `--muted` | `#6A7066` | Secondary text |
| `--accent` | `#2F5A48` | Primary button, active tab |
| `--on-accent` | `#FFFFFF` | Text on accent |
| `--live` | `#B9D3B0` | Live meter bars on the forest panel |
| `--sage` | `#A9BDA9` | Soft fills, image placeholders |
| `--clay` | `#C78358` | Decorative accent only, used sparingly |
| `--ok` | `#2F7A55` | "Good" conditions |
| `--warn` | `#A8661B` | Warnings |
| `--error` | `#B5432C` | Errors |
| `--focus` | `#A8661B` | Focus ring (3 px) |

**Clay rule:** clay is close to some species colours. Never place it next to a species dot, and never use it for status.

### 3.4 Species colours
- Keep the existing system: a fixed colour per species, stable across sessions.
- The same species colour in both themes. Check its contrast against `--card` in both. If one fails, adjust the card token or add a thin outline to the dot. Never change the species colour itself.
- The species name always appears beside its colour. Colour alone never identifies a bird.

### 3.5 Visualisations and maps
- Waveform, spectrogram, confidence timeline, heat map and status colours all read from theme tokens, with no hard-coded colours.
- Map tiles stay unmodified in both themes, as OpenStreetMap's policy requires. Map controls and attribution follow the theme.

## 4. Foundations

- **Spacing:** 8 px scale: 4 (tight), 8, 16, 24, 32, 48.
- **Radius:** cards 20 px; buttons and inputs 14 px; chips and pills fully round; image thumbnails 14 px.
- **Type:** Inter or the system sans. Sizes 12 / 14 / 16 (body) / 20 / 24 / 32. Weights 400 / 600 / 750. Scientific names in italics, the muted colour and 12–13 px.
- **Numbers:** tabular figures for timers and confidence values.
- **Shadows:** minimal. Separate surfaces with borders and colour, not heavy shadows.
- **Motion:** 150–250 ms ease-out. Respect `prefers-reduced-motion`: no pulsing, no animated meters, instant transitions.
- **Content width:** single column on phones. On wide screens, max 1120 px, and Listen stays centred and no wider than 560 px.

## 5. Components

**Header.** App name on the left. The status pill and theme toggle on the right. Stays at the top of every screen.

**Status pill.** A short label with a dot: "Model ready", "Listening", "Paused", "Mic blocked", "Loading model 42%", "Offline". The text is always present.

**Primary mic button (Ready state).** A large circle (at least 120 px on phones), accent fill, mic icon and the label "Start listening". The only filled button on the screen.

**Listening panel.** Shown only while listening:
- the timer and "screen stays on";
- a live level meter, which stays still when reduce-motion is on;
- the conditions line ("Good", "Windy", "Too quiet"), marked as guidance;
- a full-width "Stop listening" button.

**Result card.**
- **Layout:** Wikipedia thumbnail (falls back to a sage tile with a bird outline), then the colour dot + common name, the scientific name, confidence in % and the time ("just now", "0:40 ago").
- **Members:** a saved-clip play button with its length and confidence.
- **Tap:** the whole card opens the species page.
- **Low confidence:** results below the minimum are hidden behind "N more sounds below your minimum · show".

**Species ID card (members).** Most recent sighting: Plus Code and coordinates, each with a copy button; "Open in Google Maps"; a mini map; the saved clip. Tapping it opens the sighting history (list + map, pins/heat toggle).

**"How it works" section.** A collapsed row with a chevron. Opening it shows the waveform, spectrogram, pipeline view and timeline. It stays open for the session once opened.

**Buttons.**
- **Primary:** accent fill, at most one per card.
- **Secondary:** card background with a border.
- **Text links:** accent colour, underlined on focus and hover.
- **Height:** all buttons at least 44 px.

**Chips.** Small rounded labels for context: location, "Week 42 birds", "Min. 60%".

**Toasts.** Short confirmations ("Copied 86H8M7PV+GW"), 1.6 s, announced to screen readers.

**Bottom navigation.** Listen, Recordings, Species, Map, Settings. Icon plus label, at least 44 px tall, and the active tab in the accent colour and bold.

## 6. Listen layouts

The user picks a layout in **Settings → Listen layout**, and the choice is remembered on the device. **The default is Consolidated.** All three share the same components and states. Only their arrangement differs.

1. **Consolidated (default).**
   - **Ready:** title, short hint, mic button, context chips, then the collapsed "How it works" and "Recent sightings" rows.
   - **Listening:** the panel at the top, result cards below, newest first.
2. **Bottom dock.**
   - **Results:** the cards fill the screen.
   - **Dock:** a compact panel pinned above the bottom navigation ("● Listening · 02:14" + Stop). In the Ready state the dock shows "Start listening".
   - **Use case:** best one-handed.
3. **Focus mode.**
   - **While listening:** one large card for the latest bird (big photo, 22–24 px name, confidence, conditions) and a large Stop.
   - **Earlier birds:** one swipe up ("▲ N more birds · swipe up"). Also reachable by a button, for users who can't swipe.
   - **Use case:** best at arm's length in the field.

## 7. States and wording

| State | Status pill | Main area |
|---|---|---|
| Loading model | "Loading model 42%" | Progress bar + "One-time download, about 78 MB. Use Wi-Fi if you can." |
| Ready | "Model ready" | Mic button, "Point the bottom of your phone toward the sound." |
| Listening | "Listening" | Panel + results |
| Paused (app in background) | "Paused" | "Listening paused while the app was in the background. Tap to resume." |
| Mic blocked | "Mic blocked" | Explanation + iPhone steps (Settings → Safari → Microphone → Ask/Allow) + "Try again" + "You can still import a recording." |
| No location | n/a | Chip "No location" + one line explaining that results aren't filtered for your area |
| Offline | "Offline" | Listening works; AI questions and the map are unavailable, and the app says so |
| Error | "Something went wrong" | A plain sentence about what failed + "Try again" |

**Voice.** Plain, short and friendly. Say what happened and what to do next. No jargon in the main flow; technical terms live in "How it works" and Settings.

## 8. Accessibility checklist

- WCAG AA contrast for all text, icons and status colours in both themes.
- Focus ring visible on every interactive element: 3 px, theme `--focus`, 3 px offset.
- Full keyboard use: logical tab order, Enter/Space activates, and Escape closes sheets.
- Tap targets at least 44×44 px.
- Status changes announced with `aria-live="polite"`, and errors with `assertive`.
- Nothing plays sound unless the user taps play.
- Reduced motion respected everywhere.
- Long bird names wrap cleanly, with no clipping, from 320 px wide up to desktop.

## 9. Free vs member

- Members see the species ID card, the sighting history map, saved clips and "Ask about this bird".
- Free users see a single quiet line in those places, "Sign in to unlock", never a blocking pop-up.
- Free features (listening, identification, species pages, on-device saving, coordinates, Plus Code, Google Maps link) never show upgrade prompts.

## 10. Out of scope (for now)

- "Next bird", practice and quiz modes, and A/B call comparison: these belong to a learning app, and reference recordings carry licence conditions.
- "Listen for…" tips: there's no reliable source without the paid AI.
- Bright, high-saturation palettes: they clash with the species colours.
- Tabs inside the Listen screen.

## 11. Acceptance checks

- Playwright screenshots at iPhone size of all **3 layouts × 2 themes** in the Ready and Listening states, plus Mic blocked in both themes, saved to `docs/screenshots/`.
- The theme toggle works, persists across reloads and never flashes the wrong theme.
- Automated contrast test on the token pairs and the species colours.
- No horizontal scrolling and no clipped primary control at 320, 375, 390 and 430 px widths.
- Existing unit and e2e tests still pass.
