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
LEGO_ENV=/etc/lego/lego-birdbrain.env
SENTINEL_LEGO_ENV_DEFAULT=/etc/lego/lego-sentinel.env
LEGO_BIN_DEFAULT=/usr/local/bin/lego
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
  fi
  SENTINEL_LEGO_ENV="${SENTINEL_LEGO_ENV:-$SENTINEL_LEGO_ENV_DEFAULT}"
  LEGO_BIN="${LEGO_BIN:-$LEGO_BIN_DEFAULT}"
}
# LEGO_PATH as Sentinel's env file defines it (certificates live under $LEGO_PATH/certificates/).
lego_path() {
  local f="$LEGO_ENV"; [ -f "$f" ] || f="$SENTINEL_LEGO_ENV"
  local v; v="$(grep -E '^LEGO_PATH=' "$f" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  echo "${v:-/etc/lego}"
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
  log "Step 4/8: $LEGO_ENV (copy of Sentinel's env with only LEGO_DOMAINS changed), then lego run"
  need_conf
  if [ ! -f "$SENTINEL_LEGO_ENV" ] && [ "$DRY_RUN" = 0 ]; then echo "$SENTINEL_LEGO_ENV not found; set SENTINEL_LEGO_ENV in setup.conf" >&2; exit 78; fi
  if [ -e "$LEGO_ENV" ]; then
    echo "   $LEGO_ENV already exists; leaving it alone"
  else
    if [ "$DRY_RUN" = 1 ]; then
      echo "   [dry-run] sed 's/^LEGO_DOMAINS=.*/LEGO_DOMAINS=$DOMAIN/' $SENTINEL_LEGO_ENV > $LEGO_ENV (mode 0600; refuse if no LEGO_DOMAINS line)"
    else
      grep -qE '^LEGO_DOMAINS=' "$SENTINEL_LEGO_ENV" || { echo "$SENTINEL_LEGO_ENV has no LEGO_DOMAINS line; compare by hand" >&2; exit 78; }
      sed "s/^LEGO_DOMAINS=.*/LEGO_DOMAINS=$DOMAIN/" "$SENTINEL_LEGO_ENV" | write_file "$LEGO_ENV" 0600
      echo "   diff vs Sentinel (only LEGO_DOMAINS should differ):"; diff "$SENTINEL_LEGO_ENV" "$LEGO_ENV" || true
    fi
  fi
  local lp; lp="$(lego_path)"
  if [ -e "$lp/certificates/$DOMAIN.crt" ]; then echo "   certificate already exists; skipping"; return; fi
  if [ "$DRY_RUN" = 1 ]; then echo "   [dry-run] set -a; . $LEGO_ENV; set +a; $LEGO_BIN run"; else ( set -a; . "$LEGO_ENV"; set +a; run "$LEGO_BIN" run ); fi
  echo "   rollback: rm $LEGO_ENV; delete $lp/certificates/$DOMAIN.* (or lego revoke)"
}

step5_renew_units() {
  log "Step 5/8: lego-renew-birdbrain.service/.timer (Sentinel's pattern: EnvironmentFile + lego run + reload), run once"
  need_conf
  refuse_if_exists "$UNIT_DIR/lego-renew-birdbrain.service" "$UNIT_DIR/lego-renew-birdbrain.timer"
  [ -f "$LEGO_ENV" ] || [ "$DRY_RUN" = 1 ] || { echo "$LEGO_ENV missing; run step 4 first" >&2; exit 78; }
  if [ -f "$UNIT_DIR/lego-renew-sentinel.service" ]; then echo "   compare with Sentinel's unit:"; diff "$UNIT_DIR/lego-renew-sentinel.service" "$HERE/systemd/lego-renew-birdbrain.service" || true; fi
  write_file "$UNIT_DIR/lego-renew-birdbrain.service" 0644 < "$HERE/systemd/lego-renew-birdbrain.service"
  write_file "$UNIT_DIR/lego-renew-birdbrain.timer" 0644 < "$HERE/systemd/lego-renew-birdbrain.timer"
  run systemctl daemon-reload
  run systemctl enable --now lego-renew-birdbrain.timer
  run systemctl start lego-renew-birdbrain.service
  run systemctl status --no-pager lego-renew-birdbrain.service || true  # status exits 3 for an inactive oneshot
  echo "   rollback: systemctl disable --now lego-renew-birdbrain.timer; rm $UNIT_DIR/lego-renew-birdbrain.{service,timer}; systemctl daemon-reload"
}

step6_nginx_full() {
  log "Step 6/8: Nginx port-443 block (proxy to 127.0.0.1:8010, limits, headers), nginx -t, reload"
  need_conf
  local lp; lp="$(lego_path)"
  [ -e "$lp/certificates/$DOMAIN.crt" ] || [ "$DRY_RUN" = 1 ] || { echo "certificate missing ($lp/certificates/$DOMAIN.crt); run step 4 first" >&2; exit 1; }
  sed -e "s#__LEGO_PATH__#$lp#g" "$HERE/nginx/birdbrain" | write_file "$NGINX_AVAIL" 0644 stage1-ok
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
  if id -nG "$DEPLOY_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then echo "REFUSING: $DEPLOY_USER is in the docker group (it must only reach Docker via the sudo rule)" >&2; exit 73; fi
  run install -o root -g root -m 0750 "$HERE/birdbrain-deploy.sh" "$DEPLOY_SCRIPT"
  run visudo -cf "$HERE/sudoers-birdbrain-deploy"
  run install -o root -g root -m 0440 "$HERE/sudoers-birdbrain-deploy" "$SUDOERS_FILE"
  # In a dry run the user does not exist yet (getent fails under pipefail): assume the default home.
  local home; home="$(getent passwd "$DEPLOY_USER" 2>/dev/null | cut -d: -f6)" || true; home="${home:-/home/$DEPLOY_USER}"
  refuse_if_exists "$home/.ssh/authorized_keys"
  # Root owns .ssh and authorized_keys (sshd StrictModes accepts root ownership) so the deploy
  # user cannot loosen its own forced-command restrictions.
  run install -d -o root -g root -m 0755 "$home/.ssh"
  local key; key="$(tr -d '\n' < "$DEPLOY_PUBKEY_FILE")"
  printf 'restrict,command="sudo %s",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty %s\n' "$DEPLOY_SCRIPT" "$key" | write_file "$home/.ssh/authorized_keys" 0644
  echo "   rollback: userdel -r $DEPLOY_USER; rm $DEPLOY_SCRIPT $SUDOERS_FILE"
}

step8_container() {
  log "Step 8/8: pull the image, make the volumes writable for uid 1000, start the container (127.0.0.1:8010), wait for /health"
  [ -s "$ENV_FILE" ] || [ "$DRY_RUN" = 1 ] || { echo "$ENV_FILE is empty; add the variables first" >&2; exit 78; }
  grep -qE '^BIRDBRAIN_IMAGE_TAG=' "$ENV_FILE" 2>/dev/null && echo "   image tag: $(grep -E '^BIRDBRAIN_IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2)" || echo "   note: BIRDBRAIN_IMAGE_TAG not set in $ENV_FILE; compose falls back to :latest"
  (
    cd "$APP_DIR"
    run docker compose pull api
    # `create` builds the container and its named volumes without starting anything. The image
    # has no /data or /backups directory, so Docker would create those mount points as root:root
    # 0755 and the app (user 1000, read-only root fs) could not write its SQLite file. Chown the
    # two volumes from a throwaway container; harmless when repeated.
    run docker compose create api
    run docker run --rm --network none -v birdbrain-data:/data -v birdbrain-backups:/backups alpine chown 1000:1000 /data /backups
    run docker compose up -d api
  )
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
