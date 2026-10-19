# Deploying the API (server side, Phase 1/4 on the server)

Everything here is installed by Sabih on 95.216.159.93 after approval; nothing
in this repository touches the server by itself. Rollback for every step is the
reverse action listed next to it.

## 0. Scripts in this folder

| File | Purpose |
| --- | --- |
| `setup.sh` | Numbered steps 1-8 (preflight, /opt/birdbrain + .env, Nginx port-80 block, lego certificate, renew service/timer, Nginx port-443 block, deploy user, container). `--dry-run` prints every command and writes nothing; `--only N` / `--from N` to resume. Refuses to overwrite any target file it did not create (the stage-1 Nginx file is the one exception, recognised by its `# birdbrain-stage: http-only` marker). Only ever `nginx -t` then `systemctl reload nginx`. |
| `setup.conf.example` | Copy to `setup.conf`; set `DEPLOY_PUBKEY_FILE` (step 7 refuses without it). Lego settings are not configured here: step 4 copies `/etc/lego/lego-sentinel.env` to `/etc/lego/lego-birdbrain.env` changing only `LEGO_DOMAINS`, exactly Sentinel's pattern. |
| `rollback.sh` | Reverse order: container, deploy user, Nginx site (checked for our marker), renewal units. Keeps `.env`, the data volumes and the certificate unless `--purge`. |
| `verify.sh` | `baseline` records the status codes of `/`, `/vault`, `/wellmark/` and `sabih-sentinel.duckdns.org`; `check` diffs them, checks Birdbrain's `/health`, the HTTP→HTTPS redirect and security headers, and that port 8010 is **not** reachable on the public address (curl to `95.216.159.93:8010` must get no response; `ss -tln` must show only `127.0.0.1:8010`). Run `baseline` before step 1 and `check` after step 8. |
| `nginx/birdbrain.http-only`, `nginx/birdbrain` | Stage-1 (ACME + redirect) and final (proxy to `127.0.0.1:8010`, `limit_req` 6 r/min burst 5 → 429, `limit_conn` 3, 16 KB bodies, HSTS/nosniff/no-referrer, no CORS) site files. `__LEGO_PATH__` is substituted from `setup.conf`. |
| `systemd/lego-renew-birdbrain.service`, `.timer` | Sentinel's pattern: `EnvironmentFile=/etc/lego/lego-birdbrain.env`, `ExecStart=/usr/local/bin/lego run`, `ExecStartPost` runs `nginx -t && systemctl reload nginx`. Step 5 prints a diff against `lego-renew-sentinel.service` before installing. |
| `birdbrain-deploy.sh`, `sudoers-birdbrain-deploy`, `authorized_keys.example` | The forced-command deploy user (section 1). |

Suggested order: `verify.sh baseline` → `setup.sh --dry-run` → `setup.sh` → add
`.env` values → `setup.sh --only 8` → `verify.sh check`.

## 1. Deploy user and files

| Step | Command (as root) | Rollback |
| --- | --- | --- |
| Create the user, no password, no shell login beyond the forced command | `useradd --system --create-home --shell /bin/sh birdbrain-deploy` | `userdel -r birdbrain-deploy` |
| Install the script | `install -o root -g root -m 0750 server/deploy/birdbrain-deploy.sh /usr/local/sbin/birdbrain-deploy.sh` | `rm /usr/local/sbin/birdbrain-deploy.sh` |
| Let the deploy user run exactly that script via sudo, no arguments | `visudo -cf server/deploy/sudoers-birdbrain-deploy && install -o root -g root -m 0440 server/deploy/sudoers-birdbrain-deploy /etc/sudoers.d/birdbrain-deploy` | `rm /etc/sudoers.d/birdbrain-deploy` |
| Authorise the CI key with a forced command | copy `server/deploy/authorized_keys.example` to `~birdbrain-deploy/.ssh/authorized_keys` with the real public key; `chmod 700 ~birdbrain-deploy/.ssh; chmod 600 .../authorized_keys; chown -R birdbrain-deploy:` | delete the file |
| Compose file and env | `install -o root -g root -m 0644 server/compose.yml /opt/birdbrain/compose.yml`; `/opt/birdbrain/.env` already exists (root, 0600) | remove the compose file |

The script runs `docker compose pull` and `up -d` for the `api` service in
`/opt/birdbrain`, waits for `GET http://127.0.0.1:8010/health`, and exits
non-zero (with the last log lines) if the container is not healthy within a
minute. It takes a lock so two deploys cannot overlap.

Group membership: the user does **not** join the `docker` group; Docker is only
reached as root through the single sudo rule.

## 2. GitHub side

Repository secrets used by `.github/workflows/server-image.yml`:

- `DEPLOY_SSH_KEY`: the private half of the key in `authorized_keys` (ed25519, generated
  with `ssh-keygen -t ed25519 -C birdbrain-deploy@github-actions -N ""`, never stored on the server).
- `DEPLOY_KNOWN_HOSTS`: the server's host key line, from `ssh-keyscan -t ed25519 bird-brain.duckdns.org`.

The `deploy` job runs only after the image is pushed on `main`. The SSH client
command it sends is ignored by the forced command; it only needs the connection
to succeed and the script's exit code.

## 3. How the server pulls `ghcr.io/sabihusman/birdbrain-api`

The image is pushed by `.github/workflows/server-image.yml` with the workflow's
`GITHUB_TOKEN`. On its first push GitHub creates the package **private** and
links it to the repository.

**Plan: make the package public.** The image contains only the compiled server,
its npm dependencies and the public BirdNET label list; no secrets are baked in
(they come from `/opt/birdbrain/.env` at run time), so a public package is
acceptable and needs no credentials on the server:

1. GitHub → your profile → Packages → `birdbrain-api` → Package settings →
   Danger zone → Change visibility → Public.
2. On the server, `docker compose pull api` then works anonymously; `setup.sh`
   step 8 and `birdbrain-deploy.sh` assume this.

**Alternative: keep it private and log the server in.** Create a fine-grained
or classic personal access token with only `read:packages`, then as root:

```
echo "<token>" | docker login ghcr.io -u sabihusman --password-stdin
```

Docker stores it in `/root/.docker/config.json` (make sure it is mode 600 and
not in any backup you share). Rotate the token when it expires and never put it
in `.env` or the repository. Everything else is unchanged.

**Pinning.** `compose.yml` uses `ghcr.io/sabihusman/birdbrain-api:${BIRDBRAIN_IMAGE_TAG:-latest}`;
compose reads that variable from `/opt/birdbrain/.env`, so pin with
`BIRDBRAIN_IMAGE_TAG=sha-1cc01d4` there. The forced-command deploy pulls whatever
tag is pinned, so promoting a new build means editing that one line (or setting
`latest`) and running the deploy script. Digest pinning (`@sha256:...`) is the
stricter option once the image is stable.

## 4. Daily backup

`server/scripts/backup.sh` wraps `docker exec birdbrain-api node dist/backup.js`
(SQLite `VACUUM INTO` plus retention pruning into the `birdbrain-backups`
volume). Install it as a root cron job; see the comment in the script.

## 5. Manual deploy / rollback of the app itself

- Manual deploy: `sudo /usr/local/sbin/birdbrain-deploy.sh` as root.
- Roll back to a previous image: set `BIRDBRAIN_IMAGE_TAG=sha-<previous>` in
  `/opt/birdbrain/.env` and run the deploy script; the SQLite schema is additive, so older images keep working with a
  newer database.
