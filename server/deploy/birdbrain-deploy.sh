#!/usr/bin/env bash
# Birdbrain API deploy script.
# Install as /usr/local/sbin/birdbrain-deploy.sh, owner root:root, mode 0750.
# It is only ever started by sudo from the forced SSH command of the
# birdbrain-deploy user (see deploy/sudoers-birdbrain-deploy and
# deploy/authorized_keys.example). It takes no arguments and ignores
# SSH_ORIGINAL_COMMAND, so a compromised CI key can do exactly one thing:
# pull the current image and restart the Birdbrain container.
set -euo pipefail
umask 027
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset SSH_ORIGINAL_COMMAND

COMPOSE_DIR=/opt/birdbrain
LOCK=/run/lock/birdbrain-deploy.lock
HEALTH_URL=http://127.0.0.1:8010/health

if [ "$#" -ne 0 ]; then
  echo "birdbrain-deploy: no arguments accepted" >&2
  exit 64
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "birdbrain-deploy: must run as root via sudo" >&2
  exit 77
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "birdbrain-deploy: another deploy is running" >&2
  exit 75
fi

cd "$COMPOSE_DIR"
echo "[deploy] $(date -u +%FT%TZ) pulling image"
docker compose pull --quiet api
echo "[deploy] starting container"
docker compose up -d --remove-orphans api

for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "[deploy] healthy: $(docker compose images api | tail -n +2 | awk '{print $2":"$3" "$4}')"
    docker image prune -f --filter "label=org.opencontainers.image.title=birdbrain-api" >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

echo "[deploy] container did not become healthy; last log lines:" >&2
docker compose logs --tail=40 api >&2 || true
exit 1
