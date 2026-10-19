# Live hardening checklist: `/v1/ask` with Ollama Cloud and Gemini

Run this against `https://bird-brain.duckdns.org` after deploying the
provider chain (DECISIONS.md #49). Every command is read-only for the server
except the questions it asks, which count against your own daily cap. Replace
`$TOKEN` with a bearer token from the app (Settings › Account, or the
`/v1/auth/verify` response) and keep keys out of shell history
(`export OLLAMA_API_KEY=…` in a subshell, or read them from
`/opt/birdbrain/.env` as root).

Shell on the server: `cd /opt/birdbrain` and `docker compose logs -f api`
for the log lines named below. Nothing below touches the other sites on the
host; `server/deploy/verify.sh check` remains the acceptance test.

## 1. Before deploying

- [ ] `/opt/birdbrain/.env` (root, 0600) has `OLLAMA_API_KEY`, `OLLAMA_MODEL`
      (currently `gemma4:31b`), `GEMINI_API_KEY`, `GEMINI_MODEL` (currently
      `gemini-3.5-flash-lite`). `AI_PROVIDER_ORDER` unset means
      `ollama,gemini`. Nothing in the repository names a model.
- [ ] The key works and the model exists for the account:
      `curl -s https://ollama.com/api/tags -H "Authorization: Bearer $OLLAMA_API_KEY" | grep -o '"name":"[^"]*"'`
      lists `gemma4:31b` (the docs' example sends no header for this URL; if
      it answers 401 without one, the header is required, which is what the
      server does for chat anyway).
- [ ] A direct chat call answers 200 with `"done_reason":"stop"` and token
      counts (this is the call that was confirmed live on 2026-10-19 with
      `gpt-oss:20b`):
      `curl -s https://ollama.com/api/chat -H "Authorization: Bearer $OLLAMA_API_KEY" -H "Content-Type: application/json" -d '{"model":"gemma4:31b","messages":[{"role":"system","content":"Answer in one short sentence."},{"role":"user","content":"Name one bird."}],"stream":false}'`
      Expected fields: `message.content`, `done: true`, `done_reason`,
      `prompt_eval_count`, `eval_count`. Note the `done_reason` value you see;
      the server treats anything but `stop` as a cut answer and falls back.

## 2. After deploying (`docker compose logs api | head`)

- [ ] Startup shows `[startup] /v1/ask providers: ollama (gemma4:31b) -> gemini (gemini-3.5-flash-lite)`.
      If a key is missing you see `[startup] OLLAMA_API_KEY not set: Ollama
      provider skipped` instead, and the chain is Gemini only; that is a
      configuration gap, not a crash.
- [ ] `curl -s https://bird-brain.duckdns.org/health` → `{"ok":true}`.
- [ ] `server/deploy/verify.sh check` passes (other sites unchanged, port 8010
      loopback only).

## 3. A normal question goes to Ollama

- [ ] As an approved member:
      `curl -s -X POST https://bird-brain.duckdns.org/v1/ask -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Origin: https://sabihs-birdbrain.vercel.app" -d '{"species":"Turdus merula","question":"What does it eat?"}'`
      → 200 with `answer`, `source`, `citations`, `context`.
- [ ] Log: one line `[ask] provider=ollama model=gemma4:31b fallback_from=- fallback_reason=- finish=stop prompt_tokens=… answer_tokens=… total_tokens=… duration_ms=… day_requests=1 day_prompt_tokens=… day_answer_tokens=… day_fallbacks=0`.
      No `[ask] attempt=` line (that is Gemini's). No question text anywhere.
- [ ] The answer cites sections in square brackets and is under 120 words.
      If it ends with "(answer cut short)" on Ollama alone, the model is
      verbose for this prompt: consider another shortlisted model
      (`OLLAMA_MODEL=nemotron-3-nano:30b` or `gpt-oss:20b`) and re-run the
      eval (section 7).
- [ ] Ask the same question again: 200 with `cached: true` and the line
      `[ask] attempt=0 finish=CACHE …` (DECISIONS #48); no provider line,
      `day_requests` unchanged.

## 4. Fallback drill: wrong Ollama key

- [ ] As root, edit `/opt/birdbrain/.env`: set `OLLAMA_API_KEY=wrong`
      (keep the real value in a comment), then `docker compose up -d api`.
- [ ] Ask a **new** question (the cache would answer a repeat). Expected: 200,
      a normal answer. Logs:
      `[ask] provider=ollama failed reason=auth (falling back)` then Gemini's
      `[ask] attempt=1 … cost_usd=…` and
      `[ask] provider=gemini model=gemini-3.5-flash-lite fallback_from=ollama fallback_reason=auth … day_fallbacks=1`.
- [ ] The member never saw an error: the response body has no `error` field.
- [ ] Restore the key, `docker compose up -d api`, confirm the startup line and
      one more question answered by `provider=ollama`.

## 5. Fallback drill: timeout and limit

- [ ] Temporarily set `OLLAMA_TIMEOUT_MS=1000` and ask a new question: either
      Ollama answers inside a second (unlikely for a 31B model) or you see
      `failed reason=timeout (falling back)` and Gemini answers. Restore
      `8000`.
- [ ] Free plan concurrency is 1 and the queue can be full: fire two questions
      at once from two shells (different questions). Expected: both 200; the
      log shows at most one `reason=rate_limit` or `reason=queue_full`
      fallback and no 5xx to the client.
- [ ] Watch the allowance: `https://ollama.com/settings/usage`, and on the
      Admin page the "Provider" table (answers, after-fallback count, tokens
      per provider over 30 days). `GET /v1/admin/ask-costs` as the admin
      returns `providers: [{provider, requests, promptTokens, answerTokens, fallbacks}]`.

## 6. Error paths stay generic

- [ ] Unapproved or signed-out: `/v1/ask` without a token → 401
      `unauthorized`; with a pending account → 403 `not_approved`; nothing in
      the log mentions a provider for these (no call is made).
- [ ] Rate limit: 11 requests in a minute from one IP → 429 `rate_limited`;
      over the daily cap → 429 `user_cap`. Neither reaches a provider.
- [ ] Both providers down (wrong Ollama key and wrong Gemini key together):
      502 `{"error":"model_unavailable"}`, the app says "The answer service is
      unavailable right now", and the log ends with
      `[ask] provider=gemini failed reason=auth (no provider left)`. The
      request still counted against the daily cap. Restore both keys.
- [ ] `grep -c 'QUESTION' <(docker compose logs api)` is 0 and no log line
      contains a key fragment.

## 7. Eval (optional, costs about $0.04 on Gemini plus 24 Ollama calls)

- [ ] `GEMINI_API_KEY=… OLLAMA_API_KEY=… npx tsx scripts/eval-models.ts --models gemini-3.5-flash-lite --ollama gemma4:31b --dry-run`
      then without `--dry-run`. Read the "Flagged answers" column: any
      `leak`, `injected` or `markup` flag on the adversarial rows is a model
      that misbehaved (the server still rejected or sanitised it); `cut_off`
      or `provider_error` on the bird rows means the model or the plan is not
      up to the job. Note the result in DECISIONS #49 ("Model" bullet).

## 8. Rolling back

- [ ] Fastest: `AI_PROVIDER_ORDER=gemini` in `.env`, `docker compose up -d api`
      (Ollama is never called; the log says `providers: gemini (…)`).
- [ ] Previous image: set `BIRDBRAIN_IMAGE_TAG=sha-<previous commit>` in
      `.env` and `docker compose up -d api`, or `server/deploy/rollback.sh`.
      The `ask_provider_usage` table is additive and harmless to an older
      image.
