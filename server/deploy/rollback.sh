#!/usr/bin/env bash
# Undo setup.sh in reverse order. Only touches Birdbrain's own files, units, user and
# container; never other sites, nginx.conf, other containers, cron, or a restart of nginx.
#   sudo server/deploy/rollback.sh --dry-run
#   sudo server/deploy/rollback.sh                 # keeps /opt/birdbrain/.env, data volumes and the certificate
#   sudo server/deploy/rollback.sh --purge         # also removes the data/backup volumes and /opt/birdbrain (not the certificate)
set -euo pipefail
DRY_RUN=0; PURGE=0
for a in "$@"; do case "$a" in --dry-run) DRY_RUN=1 ;; --purge) PURGE=1 ;; *) echo "unknown option $a" >&2; exit 64 ;; esac; done
run() { if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else printf '   + %s\n' "$*"; "$@" || true; fi; }
log() { printf '\n==> %s\n' "$*"; }
[ "$DRY_RUN" = 1 ] || [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 77; }

log "8. container"
[ -f /opt/birdbrain/compose.yml ] && ( cd /opt/birdbrain && run docker compose down --remove-orphans )
[ "$PURGE" = 1 ] && { run docker volume rm birdbrain-data birdbrain-backups; run docker network rm birdbrain; }

log "7. deploy user"
run rm -f /etc/sudoers.d/birdbrain-deploy /usr/local/sbin/birdbrain-deploy.sh
id birdbrain-deploy >/dev/null 2>&1 && run userdel -r birdbrain-deploy

log "6+3. nginx site (ours only), then nginx -t and reload"
if [ -e /etc/nginx/sites-available/birdbrain ] && ! grep -q '^# birdbrain-stage:' /etc/nginx/sites-available/birdbrain; then
  echo "REFUSING: /etc/nginx/sites-available/birdbrain has no birdbrain-stage marker; not ours?" >&2; exit 73
fi
run rm -f /etc/nginx/sites-enabled/birdbrain /etc/nginx/sites-available/birdbrain
if [ "$DRY_RUN" = 1 ]; then echo "   [dry-run] nginx -t && systemctl reload nginx"; else nginx -t && systemctl reload nginx; fi

log "5. renewal units"
run systemctl disable --now lego-renew-birdbrain.timer
run rm -f /etc/systemd/system/lego-renew-birdbrain.service /etc/systemd/system/lego-renew-birdbrain.timer
run systemctl daemon-reload

log "4. lego env file (ours) removed; certificate left in place (delete by hand under <LEGO_PATH>/certificates/bird-brain.duckdns.org.* if wanted)"
run rm -f /etc/lego/lego-birdbrain.env

log "2. app dir"
if [ "$PURGE" = 1 ]; then run rm -rf /opt/birdbrain; else echo "   keeping /opt/birdbrain (.env holds secrets); remove with --purge"; fi
log "done"
