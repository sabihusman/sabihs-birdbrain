#!/usr/bin/env bash
# Read-only update planner for the Birdbrain host (95.216.159.93, shared with other projects).
#
# Lists the packages apt would upgrade, grouped as security / kernel / docker / nginx /
# openssl / other, says whether a reboot would be needed, and writes a plain-text report
# under /opt/birdbrain/reports/. It installs, upgrades, holds, restarts and reloads NOTHING.
#
#   scripts/server/update-planner.sh              # plan + report
#   scripts/server/update-planner.sh --dry-run    # show what would be read/written; write nothing
#   scripts/server/update-planner.sh --report -   # print the report to stdout only
#
# Only reads: `apt list --upgradable` (or `apt-get -s upgrade`), /var/run/reboot-required*,
# `needrestart -b` when installed. Only writes: one report file (overwritten in place, so
# re-running on the same day is idempotent). Refuses to run as root: nothing here needs it.
set -euo pipefail

BIRDBRAIN_HOME="${BIRDBRAIN_HOME:-/opt/birdbrain}"      # test hook: point at a fake tree
RUN_DIR="${BB_RUN_DIR:-/var/run}"                        # test hook: fake /var/run
APT_LIST_FILE="${BB_APT_LIST_FILE:-}"                    # test hook: canned `apt list --upgradable` output
DRY_RUN=0
REPORT=""

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --dry-run        print what would be read and where the report would go; write nothing
  --report PATH    report file (default ${BIRDBRAIN_HOME}/reports/update-plan-YYYY-MM-DD.txt; "-" = stdout only)
  --help           this text

Exit codes: 0 plan written, 2 bad usage, 3 apt not usable, 77 refused (root).
Environment (tests): BIRDBRAIN_HOME, BB_RUN_DIR, BB_APT_LIST_FILE, BB_TEST_UID.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --report) [ $# -ge 2 ] || { echo "--report needs a path" >&2; exit 2; }; REPORT="$2"; shift ;;
    --report=*) REPORT="${1#--report=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

uid="${BB_TEST_UID:-$(id -u)}"
if [ "$uid" -eq 0 ]; then
  echo "REFUSED: do not run the update planner as root. It only reads package state, which any user can do." >&2
  echo "         Run it as your normal user: $0" >&2
  exit 77
fi

today="$(date -u +%Y-%m-%d)"
[ -n "$REPORT" ] || REPORT="${BIRDBRAIN_HOME}/reports/update-plan-${today}.txt"

log() { printf '==> %s\n' "$*" >&2; }

# ---- 1. collect upgradable packages (read-only) ---------------------------------------
# Output lines: "pkg<TAB>origin<TAB>new<TAB>old"
collect_upgradable() {
  if [ -n "$APT_LIST_FILE" ]; then
    cat "$APT_LIST_FILE"
  elif command -v apt >/dev/null 2>&1; then
    # `apt list` prints "pkg/suite version arch [upgradable from: old]"; the WARNING about the
    # unstable CLI goes to stderr and is dropped.
    apt list --upgradable 2>/dev/null
  elif command -v apt-get >/dev/null 2>&1; then
    # Simulation only (-s). Lines: "Inst pkg [old] (new suite ...)" -> rewritten to the apt-list shape.
    apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | awk '$1=="Inst" {
      old=$3; gsub(/[\[\]]/,"",old); new=$4; gsub(/[()]/,"",new); suite=$5
      printf "%s/%s %s amd64 [upgradable from: %s]\n", $2, suite, new, old }'
  else
    return 3
  fi | awk -F'[/ ]' '/\[upgradable from:/ {
      pkg=$1; origin=$2; new=$3
      old=$0; sub(/.*upgradable from: /,"",old); sub(/\].*/,"",old)
      printf "%s\t%s\t%s\t%s\n", pkg, origin, new, old }'
}

classify() {           # $1 = package name, $2 = origin/suite -> group name
  case "$2" in *-security*|*security*) echo security; return ;; esac
  case "$1" in
    linux-image*|linux-headers*|linux-modules*|linux-generic*|linux-hwe*|linux-virtual*|linux-firmware|linux-base) echo kernel ;;
    docker*|containerd*|runc) echo docker ;;
    nginx*|libnginx*) echo nginx ;;
    openssl|libssl*|ca-certificates) echo openssl ;;
    *) echo other ;;
  esac
}

# ---- 2. gather --------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] would read: apt list --upgradable (fallback: apt-get -s upgrade), ${RUN_DIR}/reboot-required{,.pkgs}, needrestart -b (if installed)"
  log "[dry-run] would write: ${REPORT} (and nothing else); never apt-get install/upgrade, never systemctl"
  log "[dry-run] done"
  exit 0
fi

if ! upgradable="$(collect_upgradable)"; then
  echo "apt/apt-get not found or not usable; nothing to plan" >&2
  exit 3
fi

reboot_file_present=0; reboot_pkgs=""
[ -e "${RUN_DIR}/reboot-required" ] && reboot_file_present=1
[ -r "${RUN_DIR}/reboot-required.pkgs" ] && reboot_pkgs="$(sort -u "${RUN_DIR}/reboot-required.pkgs" | tr '\n' ' ')"

needrestart_out=""
if command -v needrestart >/dev/null 2>&1; then
  # -b = batch mode, report only. As a non-root user it may see less; that is fine.
  needrestart_out="$(needrestart -b 2>/dev/null || true)"
fi

# ---- 3. build the report ----------------------------------------------------------------
declare -A groups=([security]="" [kernel]="" [docker]="" [nginx]="" [openssl]="" [other]="")
declare -A counts=([security]=0 [kernel]=0 [docker]=0 [nginx]=0 [openssl]=0 [other]=0)
total=0
while IFS=$'\t' read -r pkg origin new old; do
  [ -n "$pkg" ] || continue
  g="$(classify "$pkg" "$origin")"
  groups[$g]+="$(printf '  %-40s %-28s -> %s  (%s)\n' "$pkg" "$old" "$new" "$origin")"$'\n'
  counts[$g]=$(( counts[$g] + 1 )); total=$(( total + 1 ))
done <<< "$upgradable"

reboot_needed=no; reboot_why=""
if [ "$reboot_file_present" = 1 ]; then reboot_needed=yes; reboot_why="${RUN_DIR}/reboot-required exists (${reboot_pkgs:-no package list})"; fi
if [ "${counts[kernel]}" -gt 0 ]; then
  reboot_needed=yes; reboot_why="${reboot_why:+$reboot_why; }a kernel package would be upgraded (reboot after installing)"
fi
if [ "$reboot_needed" = no ] && printf '%s' "$needrestart_out" | grep -q '^NEEDRESTART-KSTA: [23]'; then
  reboot_needed=yes; reboot_why="needrestart reports a kernel newer than the running one"
fi

report="$(
  echo "Birdbrain host update plan   ${today} $(date -u +%H:%MZ)   host: $(hostname 2>/dev/null || echo '?')"
  echo "Read-only: nothing was installed, upgraded, restarted or reloaded by this script."
  echo
  echo "Upgradable packages: ${total}"
  for g in security kernel docker nginx openssl other; do
    echo "[${g}] ${counts[$g]}"
    [ -n "${groups[$g]}" ] && printf '%s' "${groups[$g]}"
  done
  echo
  echo "Reboot needed: ${reboot_needed}${reboot_why:+ - $reboot_why}"
  if [ -n "$needrestart_out" ]; then
    echo
    echo "needrestart -b:"
    printf '%s\n' "$needrestart_out" | sed 's/^/  /'
  else
    echo "needrestart: not installed or no output (install it on the host for service-restart hints; optional)"
  fi
  echo
  echo "What to do (by hand, only after reading SERVER_RUNBOOK.md):"
  if [ "${counts[docker]}" -gt 0 ]; then echo "  - docker/containerd upgrades restart EVERY container on this host, including the other projects' - schedule it."; fi
  if [ "${counts[nginx]}" -gt 0 ]; then echo "  - nginx upgrade reloads/restarts nginx for ALL sites - run verify.sh baseline first, check after."; fi
  if [ "${counts[kernel]}" -gt 0 ] || [ "$reboot_needed" = yes ]; then echo "  - a reboot takes every project on the host down for ~1-2 min - announce it."; fi
  if [ "$total" -eq 0 ]; then echo "  - nothing to install."; else echo "  - security first: sudo apt-get install --only-upgrade <pkgs> (not run by this script)."; fi
)"

printf '%s\n' "$report"

if [ "$REPORT" = "-" ]; then
  log "report printed to stdout only (--report -)"
  exit 0
fi

dir="$(dirname "$REPORT")"
if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
  log "report NOT written: ${dir} is not writable by $(id -un)."
  log "once, as root: install -d -m 0755 -o $(id -un) ${dir}   (or pass --report <path> / --report -)"
  exit 0
fi
tmp="$(mktemp "${dir}/.update-plan.XXXXXX")"
printf '%s\n' "$report" > "$tmp"
mv -f "$tmp" "$REPORT"
log "report written: ${REPORT}"
