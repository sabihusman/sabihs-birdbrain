# Deploying the API (server side, Phase 1/4 on the server)

Everything here is installed by Sabih on 95.216.159.93 after approval; nothing
in this repository touches the server by itself. Rollback for every step is the
reverse action listed next to it.

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

## 3. Daily backup

`server/scripts/backup.sh` wraps `docker exec birdbrain-api node dist/backup.js`
(SQLite `VACUUM INTO` plus retention pruning into the `birdbrain-backups`
volume). Install it as a root cron job; see the comment in the script.

## 4. Manual deploy / rollback of the app itself

- Manual deploy: `sudo /usr/local/sbin/birdbrain-deploy.sh` as root.
- Roll back to a previous image: edit `/opt/birdbrain/compose.yml` to pin
  `image: ghcr.io/sabihusman/birdbrain-api:sha-<previous>` and run the deploy
  script; the SQLite schema is additive, so older images keep working with a
  newer database.
