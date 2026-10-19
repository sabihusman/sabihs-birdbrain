#!/usr/bin/env bash
# Baseline / check for the other projects on 95.216.159.93 plus Birdbrain's own checks.
#   server/deploy/verify.sh baseline   # record current status codes to /opt/birdbrain/baseline.txt (or $BASELINE)
#   server/deploy/verify.sh check      # re-run and diff against the baseline; also checks Birdbrain
# The status checks run anywhere with curl; the port-8010 listener check needs `ss` on the server.
set -uo pipefail
MODE="${1:-check}"
BASELINE="${BASELINE:-/opt/birdbrain/baseline.txt}"
SERVER_IP=95.216.159.93
status() { curl -k -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo 000; }

collect() {
  printf 'learning-with-sabih /        %s\n' "$(status https://$SERVER_IP/)"
  printf 'mba-vault /vault             %s\n' "$(status https://$SERVER_IP/vault)"
  printf 'wellmark /wellmark/          %s\n' "$(status https://$SERVER_IP/wellmark/)"
  printf 'sentinel                     %s\n' "$(status https://sabih-sentinel.duckdns.org/)"
}

case "$MODE" in
  baseline)
    mkdir -p "$(dirname "$BASELINE")"; collect | tee "$BASELINE"; echo "saved to $BASELINE" ;;
  check)
    rc=0
    echo "== other projects (must match baseline)"
    now="$(collect)"; echo "$now"
    if [ -f "$BASELINE" ]; then
      if diff <(echo "$now") "$BASELINE" >/dev/null; then echo "   unchanged vs baseline"; else echo "   CHANGED vs baseline:"; diff <(echo "$now") "$BASELINE" || true; rc=1; fi
    else echo "   no baseline file ($BASELINE); run '$0 baseline' first"; fi

    echo "== birdbrain"
    h="$(status https://bird-brain.duckdns.org/health)"; echo "https://bird-brain.duckdns.org/health   $h"; [ "$h" = 200 ] || rc=1
    r="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://bird-brain.duckdns.org/health 2>/dev/null)"; echo "http -> https redirect                  $r"; [ "$r" = 301 ] || rc=1
    curl -sSI --max-time 10 https://bird-brain.duckdns.org/health 2>/dev/null | grep -iE '^(strict-transport-security|x-content-type-options|referrer-policy):' | sed 's/^/   /'

    echo "== port 8010 must NOT be reachable publicly"
    p="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://$SERVER_IP:8010/health" 2>/dev/null || echo 000)"
    if [ "$p" = 000 ]; then echo "   public :8010 -> no response (good)"; else echo "   public :8010 -> $p (BAD: exposed)"; rc=1; fi
    if command -v ss >/dev/null; then
      l="$(ss -tln 2>/dev/null | awk '$4 ~ /:8010$/ {print $4}' | tr '\n' ' ')"; echo "   listeners on 8010: ${l:-none}"
      case "$l" in *0.0.0.0:8010*|*\[::\]:8010*|*\*:8010*) echo "   BAD: 8010 bound to a public address"; rc=1 ;; esac
    fi
    [ "$rc" = 0 ] && echo "== OK" || echo "== PROBLEMS FOUND"; exit $rc ;;
  *) echo "usage: $0 baseline|check" >&2; exit 64 ;;
esac
