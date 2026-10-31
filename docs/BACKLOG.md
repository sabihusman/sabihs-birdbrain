# Backlog

Decided work not built yet. Each item names who decided and when; DECISIONS.md gets the entry when it ships.

## From the UI/UX audit (Oct 31, 2026), decided by Sabih on Oct 31

The audit's factual bugs (findings 1, 2 except the place search, 5, 6, 8, 10, 11, and the "No sightings"
wording in 12) are being fixed as work; these are the findings that needed a decision.

1. **Settings: move the expert controls into one folded "Advanced" section** (audit finding 3, option C).
   Window overlap, Species range threshold, Compute backend and "Why this ID" resolution go inside it;
   no renames. Also: the header pill drops "· webgl" (it stays in Settings and How it works).
2. **Sign-in lands on Listen, and a small initial in the header shows you're signed in** (finding 4, A + A).
   The initial opens My account and must fit the 320 px header (DECISIONS.md #84).
3. **"Stay signed in on this device", ticked by default** (finding 7, option A): a long session so the emailed
   code is rare. Open: the session length (30 to 90 days was offered). Server change; security trade-off
   accepted by Sabih (an unlocked lost phone stays signed in that long).
4. **Wording** (finding 9): the welcome button becomes "Start listening" (option B, replacing the
   "Start identifying" chosen in #94); "windows" is replaced with plain words in everyday text (option A).
5. **Layout bubble stays as it is** (finding 13, option A). No change.
6. **No location on Species: how to pick a place** (finding 2). Mockup of the options requested; not decided.
7. **Conservation status on the member ID card** (finding 12, option A): one line, "Conservation: [rank] in
   [state/province] — NatureServe", through a new members-only API call (the server already fetches
   NatureServe for Ask).
