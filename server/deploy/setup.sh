#!/usr/bin/env bash
# Birdbrain server setup: numbered, resumable, dry-runnable. Run as root on 95.216.159.93
# from a checkout of this repository:
#   sudo server/deploy/setup.sh --dry-run          # print every command, change nothing
#   sudo server/deploy/setup.sh                    # run all steps in order
#   sudo server/deploy/setup.sh --only 3           # run one step
#   sudo server/deploy/setup.sh --from 4           # resume from a step
# Rules baked in: never touches other sites' Nginx files, nginx.conf, other containers,
# other units or cron; never restarts nginx (only `nginx -t` then `systemctl reload nginx`);
# refuses to overwrite any target file it did not itself create (stage-1 Nginx file excepted).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CONF="${SETUP_CONF:-$HERE/setup.conf}"
[ -f "$CONF" ] || CONF=/opt/birdbrain/setup.conf

DOMAIN=bird-brain.duckdns.org
SERVER_IP=95.216.159.93
APP_DIR=/opt/birdbrain
ENV_FILE=$APP_DIR/.env
COMPOSE_FILE=$APP_DIR/compose.yml
NGINX_AVAIL=/etc/nginx/sites-available/birdbrain
NGINX_ENABLED=/etc/nginx/sites-enabled/birdbrain
ACME_WEBROOT=/var/www/acme
UNIT_DIR=/etc/systemd/system
DEPLOY_USER=birdbrain-deploy
DEPLOY_SCRIPT=/usr/local/sbin/birdbrain-deploy.sh
SUDOERS_FILE=/etc/sudoers.d/birdbrain-deploy

DRY_RUN=0; ONLY=""; FROM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --only) ONLY="$2"; shift ;;
    --from) FROM="$2"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

log()  { printf '\n==> %s\n' "$*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else printf '   + %s\n' "$*"; "$@"; fi; }
# Write a file from stdin; refuses if the target exists (unless $3 = "stage1-ok" and the
# existing file carries our stage-1 marker).
write_file() {
  local target="$1" mode="$2" policy="${3:-refuse}" content
  content="$(cat)"
  if [ -e "$target" ]; then
    if [ "$policy" = stage1-ok ] && grep -q '^# birdbrain-stage: http-only' "$target"; then
      printf '   replacing our own stage-1 file %s\n' "$target"
    else
      echo "REFUSING: $target already exists (remove it yourself if it is ours)" >&2; exit 73
    fi
  fi
  if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] write %s (mode %s, %d bytes)\n' "$target" "$mode" "${#content}"; return; fi
  printf '%s\n' "$content" > "$target"; chmod "$mode" "$target"; chown root:root "$target"
  printf '   + wrote %s\n' "$target"
}
refuse_if_exists() { for f in "$@"; do if [ -e "$f" ]; then echo "REFUSING: $f already exists" >&2; exit 73; fi; done; }
need_conf() {
  if [ -f "$CONF" ]; then
    # shellcheck disable=SC1090
    . "$CONF"
  elif [ "$DRY_RUN" = 0 ]; then
    echo "setup.conf not found ($CONF). Copy setup.conf.example and fill it from Sentinel's unit." >&2; exit 78
  fi
  for v in LEGO_BIN LEGO_PATH ACME_EMAIL; do
    if [ -z "${!v:-}" ]; then
      if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s is not set in setup.conf; using placeholder\n' "$v"; printf -v "$v" '%s' "<$v>"; else echo "setup.conf: $v is empty" >&2; exit 78; fi
    fi
  done
}
nginx_apply() {
  # The only way this script ever touches the running Nginx.
  run nginx -t
  run systemctl reload nginx
}

step1_preflight() {
  log "Step 1/8: preflight (read-only)"
  if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" -ne 0 ]; then echo "run as root" >&2; exit 77; fi
  local resolved; resolved="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')" || true
  echo "   $DOMAIN -> ${resolved:-unresolved} (expected $SERVER_IP)"
  if [ "$resolved" != "$SERVER_IP" ] && [ "$DRY_RUN" = 0 ]; then echo "STOP: DNS does not point at this server" >&2; exit 1; fi
  command -v nginx docker >/dev/null || { echo "nginx or docker missing" >&2; exit 69; }
  [ -d "$ACME_WEBROOT" ] || echo "   note: $ACME_WEBROOT missing; Sentinel's config should have created it"
  if ss -tlnp 2>/dev/null | grep -q ':8010 '; then echo "   note: something already listens on 8010"; fi
  echo "   other projects (unchanged by this script): /, /vault (127.0.0.1:3000), /wellmark/ (127.0.0.1:8001), sabih-sentinel.duckdns.org (127.0.0.1:8000)"
}

step2_appdir() {
  log "Step 2/8: $APP_DIR, .env (0600, secrets added by Sabih), compose.yml"
  run mkdir -p "$APP_DIR"
  if [ ! -e "$ENV_FILE" ]; then
    run install -o root -g root -m 0600 /dev/null "$ENV_FILE"
    echo "   add the variables from server/.env.example to $ENV_FILE yourself"
  else
    echo "   $ENV_FILE exists; leaving it alone"
  fi
  refuse_if_exists "$COMPOSE_FILE"
  run install -o root -g root -m 0644 "$HERE/../compose.yml" "$COMPOSE_FILE"
}

step3_nginx_http() {
  log "Step 3/8: Nginx port-80 block (ACME + redirect), nginx -t, reload"
  refuse_if_exists "$NGINX_AVAIL" "$NGINX_ENABLED"
  write_file "$NGINX_AVAIL" 0644 < "$HERE/nginx/birdbrain.http-only"
  run ln -s "$NGINX_AVAIL" "$NGINX_ENABLED"
  nginx_apply
  echo "   rollback: rm $NGINX_ENABLED $NGINX_AVAIL && nginx -t && systemctl reload nginx"
}

step4_cert() {
  log "Step 4/8: issue the certificate with lego (HTTP-01 via $ACME_WEBROOT), as Sentinel's was"
  need_conf
  if [ -e "$LEGO_PATH/certificates/$DOMAIN.crt" ]; then echo "   certificate already exists; skipping"; return; fi
  run "$LEGO_BIN" --accept-tos --email "$ACME_EMAIL" --path "$LEGO_PATH" --http --http.webroot "$ACME_WEBROOT" --domains "$DOMAIN" run
  echo "   rollback: lego --path $LEGO_PATH --domains $DOMAIN revoke  (optional; or just delete $LEGO_PATH/certificates/$DOMAIN.*)"
}

step5_renew_units() {
  log "Step 5/8: lego-renew-birdbrain.service/.timer (copied from Sentinel's, domain changed), run once"
  need_conf
  refuse_if_exists "$UNIT_DIR/lego-renew-birdbrain.service" "$UNIT_DIR/lego-renew-birdbrain.timer"
  sed -e "s#__LEGO_BIN__#$LEGO_BIN#g" -e "s#__LEGO_PATH__#$LEGO_PATH#g" -e "s#__ACME_EMAIL__#$ACME_EMAIL#g" "$HERE/systemd/lego-renew-birdbrain.service" | write_file "$UNIT_DIR/lego-renew-birdbrain.service" 0644
  write_file "$UNIT_DIR/lego-renew-birdbrain.timer" 0644 < "$HERE/systemd/lego-renew-birdbrain.timer"
  run systemctl daemon-reload
  run systemctl enable --now lego-renew-birdbrain.timer
  run systemctl start lego-renew-birdbrain.service
  run systemctl status --no-pager lego-renew-birdbrain.service
  echo "   rollback: systemctl disable --now lego-renew-birdbrain.timer; rm $UNIT_DIR/lego-renew-birdbrain.{service,timer}; systemctl daemon-reload"
}

step6_nginx_full() {
  log "Step 6/8: Nginx port-443 block (proxy to 127.0.0.1:8010, limits, headers), nginx -t, reload"
  need_conf
  [ -e "$LEGO_PATH/certificates/$DOMAIN.crt" ] || [ "$DRY_RUN" = 1 ] || { echo "certificate missing; run step 4 first" >&2; exit 1; }
  sed -e "s#__LEGO_PATH__#$LEGO_PATH#g" "$HERE/nginx/birdbrain" | write_file "$NGINX_AVAIL" 0644 stage1-ok
  [ -L "$NGINX_ENABLED" ] || run ln -s "$NGINX_AVAIL" "$NGINX_ENABLED"
  nginx_apply
  echo "   rollback: reinstall nginx/birdbrain.http-only over $NGINX_AVAIL (or remove both files), nginx -t, reload"
}

step7_deploy_user() {
  log "Step 7/8: $DEPLOY_USER with forced-command key, root-owned deploy script, sudoers (no arguments)"
  need_conf
  if [ -z "${DEPLOY_PUBKEY_FILE:-}" ] || [ ! -f "$DEPLOY_PUBKEY_FILE" ]; then
    [ "$DRY_RUN" = 1 ] && { echo "   [dry-run] DEPLOY_PUBKEY_FILE not set; using placeholder key"; DEPLOY_PUBKEY_FILE=/dev/null; } || { echo "setup.conf: DEPLOY_PUBKEY_FILE must point at the CI public key" >&2; exit 78; }
  fi
  refuse_if_exists "$DEPLOY_SCRIPT" "$SUDOERS_FILE"
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then run useradd --system --create-home --shell /bin/sh "$DEPLOY_USER"; else echo "   user exists"; fi
  run install -o root -g root -m 0750 "$HERE/birdbrain-deploy.sh" "$DEPLOY_SCRIPT"
  run visudo -cf "$HERE/sudoers-birdbrain-deploy"
  run install -o root -g root -m 0440 "$HERE/sudoers-birdbrain-deploy" "$SUDOERS_FILE"
  local home; home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  refuse_if_exists "$home/.ssh/authorized_keys"
  run install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "$home/.ssh"
  local key; key="$(tr -d '\n' < "$DEPLOY_PUBKEY_FILE")"
  printf 'restrict,command="sudo %s",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n' "$DEPLOY_SCRIPT" "$key" | write_file "$home/.ssh/authorized_keys" 0600
  [ "$DRY_RUN" = 1 ] || chown "$DEPLOY_USER:$DEPLOY_USER" "$home/.ssh/authorized_keys"
  echo "   rollback: userdel -r $DEPLOY_USER; rm $DEPLOY_SCRIPT $SUDOERS_FILE"
}

step8_container() {
  log "Step 8/8: pull the image and start the container (127.0.0.1:8010), wait for /health"
  [ -s "$ENV_FILE" ] || [ "$DRY_RUN" = 1 ] || { echo "$ENV_FILE is empty; add the variables first" >&2; exit 78; }
  ( cd "$APP_DIR" && run docker compose pull api && run docker compose up -d api )
  if [ "$DRY_RUN" = 0 ]; then
    for _ in $(seq 1 30); do curl -fsS --max-time 3 http://127.0.0.1:8010/health >/dev/null 2>&1 && { echo "   healthy"; break; }; sleep 2; done
    curl -fsS --max-time 5 "https://$DOMAIN/health" && echo "   public health OK" || echo "   public health FAILED (check nginx/cert)"
  fi
  echo "   rollback: cd $APP_DIR && docker compose down   (volumes birdbrain-data/birdbrain-backups are kept)"
}

STEPS=(step1_preflight step2_appdir step3_nginx_http step4_cert step5_renew_units step6_nginx_full step7_deploy_user step8_container)
if [ -n "$ONLY" ]; then "${STEPS[$((ONLY-1))]}"; exit 0; fi
for i in "${!STEPS[@]}"; do n=$((i+1)); [ "$n" -ge "$FROM" ] && "${STEPS[$i]}"; done
log "done. Run server/deploy/verify.sh check to compare with the baseline."
