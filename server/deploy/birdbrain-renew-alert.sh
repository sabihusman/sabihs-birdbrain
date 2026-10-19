#!/usr/bin/env bash
# Installed by setup.sh step 9 as /usr/local/sbin/birdbrain-renew-alert.sh (root, 0750).
# Started by systemd when lego-renew-birdbrain.service fails (OnFailure=, see the drop-in
# lego-renew-birdbrain.service.d/onfailure.conf). Emails ADMIN_EMAIL through the app's own
# mailer (node dist/alert-mail.js inside a throwaway API container, which reads
# /opt/birdbrain/.env itself), so no SMTP secret lives anywhere else on the host.
# Also logs to the journal, so a failed mail is still visible in `journalctl -u birdbrain-renew-alert`.
# Nothing here touches other projects, Nginx, cron or other units.
set -uo pipefail

DOMAIN=bird-brain.duckdns.org
APP_DIR=/opt/birdbrain
RENEW_UNIT=lego-renew-birdbrain.service
LEGO_ENV=/etc/lego/lego-birdbrain.env

host="$(hostname -f 2>/dev/null || hostname)"
# systemd >= 251 passes these to OnFailure= units; older versions leave them empty.
result="${MONITOR_SERVICE_RESULT:-unknown}"; exit_code="${MONITOR_EXIT_CODE:-unknown}"; trigger="${MONITOR_UNIT:-$RENEW_UNIT}"
subject="certificate renewal FAILED for $DOMAIN on $host"

cert_info() {
  local lp crt
  lp="$(grep -E '^LEGO_PATH=' "$LEGO_ENV" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  crt="${lp:-/etc/lego}/certificates/$DOMAIN.crt"
  if [ -r "$crt" ]; then
    echo "Current certificate ($crt):"
    openssl x509 -in "$crt" -noout -enddate -issuer 2>/dev/null || echo "  (openssl could not read it)"
  else
    echo "Current certificate: $crt not readable"
  fi
}

body="$(
  cat <<EOT
The systemd unit $trigger failed on $host at $(date -u +'%Y-%m-%dT%H:%M:%SZ').
Result: $result, exit code: $exit_code.

The certificate is NOT renewed. Let's Encrypt certificates last 90 days and lego renews
when 30 days remain, so there is time to act, but the timer will keep failing (and this
mail will repeat daily) until the cause is fixed.

$(cert_info)

What to check (as root, from the PC session):
  systemctl status $RENEW_UNIT
  journalctl -u $RENEW_UNIT -n 50 --no-pager
  curl -sS http://$DOMAIN/.well-known/acme-challenge/test   # expect 404 from Nginx, not a timeout
  set -a; . $LEGO_ENV; set +a; /usr/local/bin/lego run           # retry by hand

Last 40 journal lines of $RENEW_UNIT:
$(journalctl -u "$RENEW_UNIT" -n 40 --no-pager 2>&1 || echo '(journalctl failed)')
EOT
)"

logger -t birdbrain-renew-alert -p user.err "$subject"
if ! command -v docker >/dev/null 2>&1 || [ ! -f "$APP_DIR/compose.yml" ]; then
  echo "docker or $APP_DIR/compose.yml missing; cannot send mail. Alert body follows:" >&2
  printf '%s\n' "$body" >&2
  exit 1
fi
# --no-deps/-T: no ports published, no TTY; the service's env_file supplies the SMTP settings.
if printf '%s\n' "$body" | docker compose -f "$APP_DIR/compose.yml" run --rm --no-deps -T api node dist/alert-mail.js "$subject"; then
  logger -t birdbrain-renew-alert "alert mail sent"
else
  echo "alert mail FAILED to send; body follows:" >&2
  printf '%s\n' "$body" >&2
  logger -t birdbrain-renew-alert -p user.err "alert mail failed to send"
  exit 1
fi
