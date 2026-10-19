# Security review: Birdbrain API and member features

Scope: the `server/` service (accounts, email-code login, admin approval,
`POST /v1/ask`) and the front-end changes that talk to it. Reviewed against
the OWASP Top 10 for LLM Applications **2026** (the 2026 edition supplied by
Sabih on 2026-10-19; its publication date is still "to be set" and
genai.owasp.org served the 2025 edition when fetched the same day) and OWASP
ASVS 5.0 chapters V6 Authentication and V7 Session Management (raw chapter
text from the OWASP/ASVS repository, fetched 2026-10-19). Findings marked
**gap** are not fixed by this change.

## Design summary

- Audio, identifications and recordings never leave the phone. The API only
  sees: email, password (hashed by Better Auth), login codes, and for members
  a species name plus a question of at most 500 characters.
- Login is email + password, then a 6-digit code sent by email on every login.
  The password step creates a Better Auth session but the token is held
  server-side in `login_challenge` until the code is verified. Tokens are
  reference tokens sent as `Authorization: Bearer`; no cookies.
- New accounts are `pending`; only the account whose email equals
  `ADMIN_EMAIL` is created `approved` with role `admin`. Admin endpoints need an
  approved admin session, which itself required the email code.
- `/v1/ask` is allowed for `approved` users only, validates a strict body,
  checks the species against the BirdNET label list, fetches the Wikipedia
  summary server-side, and asks Gemini to answer from that text alone.
- The model is a component, not an actor: no tools, no memory, no retrieval
  store, no chained calls. In the 2026 list's own words, the system is built
  so that when the model is fooled nothing important breaks.

## OWASP Top 10 for LLM Applications (2026)

| Risk | Status | Notes |
| --- | --- | --- |
| LLM01:2026 Prompt injection | Mitigated | Delivery surfaces: the user's question (direct, ≤500 chars) and the Wikipedia extract (indirect, semi-trusted). The extract is bounded to 6,000 chars with control characters stripped, fenced in `<source>` tags as provenance-labelled data, and the system instruction forbids following instructions inside it. Propagation is single-shot: no memory, no corpus, no tools, so a successful injection can only yield a wrong plain-text answer to the person who asked. Residual: the 2026 entry notes structural marking is bypassable by adaptive attackers; the blast radius, not the marking, is the real control here. |
| LLM02:2026 Sensitive information disclosure | Mitigated | The model receives no user data (no email, name, location or audio) and no secrets. Question text is not logged; answers go only to the asking session. Side channels (token length, timing) reveal at most that a question was asked about a public species. |
| LLM03:2026 Excessive agency | Mitigated | Zero functionality, zero permissions, zero autonomy: the model has no tools, cannot call anything, and its output is only displayed. Authorization (approval status, caps) is enforced in application code before the model is called. |
| LLM04:2026 Supply chain | Partially | Official `@google/genai` SDK and all server dependencies pinned by exact version in `package-lock.json`; CI builds the image from a pinned Node base. **Gaps:** no dependency scanning in CI yet; the server pulls the image by the mutable `latest` tag (the forced deploy command takes no arguments, so a digest cannot be passed; mitigation: only this repository's CI token can push to the GHCR package, and `sha-<commit>` tags exist for pinning in `compose.yml`). |
| LLM05:2026 Data and model poisoning | Accepted | No training, fine-tuning, embeddings or persistent store; Wikipedia content is fetched per request. Wikipedia vandalism could reach a user as an answer; the source link is shown so it can be checked. |
| LLM06:2026 Unbounded consumption | Mitigated | Per-user and global daily caps in SQLite (`ASK_DAILY_PER_USER`, `ASK_DAILY_GLOBAL`), per-IP limiter on `/v1/ask`, question length cap, `maxOutputTokens` 400, 8-second Wikipedia timeout, 16 KB body limit, Nginx request and connection limits in front. The global cap is a hard spending ceiling, not an alert. |
| LLM07:2026 Misinformation | Partially | Answers are restricted to the Wikipedia extract and the instruction says to admit when the text does not cover the question; the source link is shown, and the UI states that answers are AI-generated and can be wrong. No decision or action is driven by the answer. **Gap:** no automated groundedness check of the answer against the extract. |
| LLM08:2026 Hidden context exposure | Accepted | The system prompt holds no secrets, credentials, tool schemas or authorization logic; approval and caps are enforced outside the model. Disclosure of the prompt reveals nothing beyond what this document states. |
| LLM09:2026 Vector and embedding weaknesses | Not applicable | No embeddings, similarity search, semantic cache or vector store. |
| LLM10:2026 Improper output handling | Mitigated | The server strips tags and control characters and caps answers at 2,000 chars; the client renders answers with `textContent`, never as HTML or Markdown, so no auto-fetched images or links can exfiltrate anything; the CSP restricts `img-src` and `connect-src` to known hosts. Nothing from the model is executed, stored or passed to another system. |

## ASVS 5.0 V6 Authentication

| Requirement | Status | Notes |
| --- | --- | --- |
| 6.1.1 Documented anti-automation | Met | This file plus Nginx: app limits 20 auth requests / 10 min per IP, 6 logins / 10 min per email, 5 code attempts per challenge; Nginx adds 6 r/min per IP with burst 5 and 3 connections per IP. |
| 6.2.1 / 6.2.9 Password length | Met | Minimum 10, maximum 128 characters (Better Auth `minPasswordLength` / `maxPasswordLength`). |
| 6.2.2 / 6.2.3 Password change | **Gap** | No password change or reset endpoint in this phase. Better Auth provides both; they are deliberately not exposed yet because a reset flow via email would need its own review. Users must ask the admin. |
| 6.2.4 / 6.2.12 Breached-password check | **Gap** | Not implemented. Better Auth's `haveibeenpwned` plugin can add this without storing passwords; candidate for a follow-up. |
| 6.2.5 / 6.2.8 No composition rules, exact verification | Met | Any characters; Better Auth hashes the exact string (scrypt). |
| 6.2.6 / 6.2.7 Masked input, paste allowed | Met | `type=password`, no paste blocking. |
| 6.3.1 Credential stuffing / brute force | Met | Limits above; generic `invalid_credentials` for wrong email or password. |
| 6.3.2 No default accounts | Met | The admin is an ordinary signup matched by `ADMIN_EMAIL`. |
| 6.3.3 Multi-factor for sensitive functions | Met | Every login (including admin) requires the emailed code; admin actions require an admin session. |
| 6.3.5 / 6.3.7 Notification of attempts and changes | Partially | A code email is sent on every successful password step, which also notifies the owner of attempts with the right password. **Gap:** no notification for repeated failed attempts or for email changes (email change is not offered). |
| 6.3.6 Email not used as an authentication factor (Level 3) | **Accepted deviation** | The brief requires an emailed 6-digit code as the second factor. ASVS Level 3 forbids email as a factor; this app targets Level 1-2. Documented so a TOTP/passkey option can replace it later. |
| 6.3.8 No user enumeration | Met | Signup always answers 200 with the same body; login answers 401 for unknown email and wrong password alike; code verification answers 401 for unknown, expired or wrong codes alike. Response timing differs slightly between unknown-email and wrong-password paths because password hashing only happens for existing users; this is the same for most Better Auth deployments and is accepted at this level. |

## ASVS 5.0 V7 Session Management

| Requirement | Status | Notes |
| --- | --- | --- |
| 7.1.1 Documented timeouts | Met | Session lifetime `SESSION_TTL_SECONDS` (default 24 h) with sliding renewal every `SESSION_UPDATE_AGE_SECONDS` (default 1 h) on use; login-code challenge `LOGIN_CODE_TTL_SECONDS` (default 10 min). **Gap:** Better Auth's sliding renewal means there is no absolute maximum beyond "24 h since last use"; see 7.3.2. |
| 7.1.2 Concurrent sessions | Met | Unlimited parallel sessions per account are allowed; disabling or rejecting a user revokes all of them. |
| 7.2.1 Backend verification | Met | Every request calls `auth.api.getSession` against SQLite. |
| 7.2.2 / 7.2.3 Dynamic, random reference tokens | Met | Better Auth session tokens are generated with a CSPRNG per login. |
| 7.2.4 New token on authentication | Met | Each login creates a new session; the token is released only after the code step. |
| 7.3.1 Inactivity timeout | Met | 24 h without use expires the session. |
| 7.3.2 Absolute maximum lifetime | **Gap** | Not enforced beyond inactivity; a continuously used session can live indefinitely. Mitigation: `disableSessionRefresh` or an absolute cap on `createdAt` can be added in a follow-up. |
| 7.4.x Token transport | Met | Bearer header only, HTTPS only (HSTS at Nginx), never in URLs; the client stores the token in `localStorage`, which is the accepted trade-off for a cross-site PWA that cannot use cookies on iOS. XSS is mitigated by the strict CSP and by never rendering HTML from data. |
| 7.5.x Logout and revocation | Met | `/v1/auth/logout` deletes the session; admin disable/reject deletes all of the user's sessions; expired challenges delete the session they guarded. |

## Other controls

- CORS is enforced in the app only: exact allowed origins from
  `ALLOWED_ORIGINS`, methods GET/POST/OPTIONS, headers Authorization and
  Content-Type, no credentials, `Vary: Origin` (verified by test).
- Bodies over 16 KB get 413 (verified by test); non-JSON bodies get 400.
- Error responses are generic codes; stack traces are never returned; logs
  contain method, path, error name and message only, never bodies.
- Container: non-root, read-only root filesystem, `cap_drop: ALL`,
  `no-new-privileges`, memory/CPU/PID limits, log rotation, bound to
  127.0.0.1:8010 only, own Docker network.
- Secrets only in `/opt/birdbrain/.env` (root, 0600); the repository holds
  only variable names.
- Deploys from CI reach the server only as the `birdbrain-deploy` user whose
  SSH key carries `restrict,command="sudo /usr/local/sbin/birdbrain-deploy.sh"`
  plus explicit no-forwarding/no-pty options; sudoers allows that exact path
  with no arguments; the script is root-owned, mode 0750, ignores
  `SSH_ORIGINAL_COMMAND`, and only pulls and restarts the Birdbrain container.

## Not verified in this phase

- Behaviour behind the real Nginx configuration (rate limits, HSTS, proxy
  headers) and the Docker hardening flags: Phases 1 and 4 run on the server.
- Gmail SMTP delivery and Gemini responses with real keys.
- The CSP on the real Vercel edge (it was verified locally by serving the
  build with the exact `vercel.json` headers in Chromium; see `scripts/csp-check.mts`).
