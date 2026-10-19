#!/usr/bin/env bash
# Backup restore test for the Birdbrain API database (SQLite, VACUUM INTO backups).
#
# Finds the newest backup in the birdbrain-backups volume, restores it into a THROWAWAY copy
# under /opt/birdbrain/tmp/, checks the copy's integrity, compares row counts per table with
# the LIVE database (opened read-only), prints a side-by-side table and deletes the copy.
# The live database file, the live container and the backup files are never written to.
#
#   scripts/server/backup-restore-test.sh                 # engine auto: docker (api image) else sqlite3
#   scripts/server/backup-restore-test.sh --dry-run       # print the plan; touch nothing, no sudo
#   scripts/server/backup-restore-test.sh --engine sqlite3
#
# Engines (verified at run time, both documented in docs/SERVER_RUNBOOK.md):
#   docker  - `docker compose run --rm --no-deps -T api node -e ...` on the api image, which
#             has node:sqlite. The one-off container mounts the same volumes as the live service
#             (no ports are published; the live container is untouched) plus the temp folder as
#             /restore. Live is opened with `new DatabaseSync(path, { readOnly: true })`.
#   sqlite3 - the host's sqlite3 CLI against the volume mount points (root-only paths under
#             /var/lib/docker/volumes, hence sudo). Live is opened with `sqlite3 -readonly`.
#
# Privileges: refuses to run as root directly. It uses `sudo` only where unavoidable and says so:
# the Docker socket (unless you are in the docker group), creating/removing the temp folder
# under root-owned /opt/birdbrain, and (sqlite3 engine) reading the root-owned backup volume.
set -euo pipefail

BIRDBRAIN_HOME="${BIRDBRAIN_HOME:-/opt/birdbrain}"
COMPOSE_FILE="${BB_COMPOSE_FILE:-${BIRDBRAIN_HOME}/compose.yml}"
BACKUP_VOLUME="${BB_BACKUP_VOLUME:-birdbrain-backups}"
DATA_VOLUME="${BB_DATA_VOLUME:-birdbrain-data}"
DOCKER="${BB_DOCKER:-docker}"           # test hook: a fake docker binary
SUDO="${BB_SUDO-sudo}"                  # test hook: "" to never call sudo
DRY_RUN=0
ENGINE=auto

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --dry-run             print every step; run nothing, create nothing, no sudo
  --engine auto|docker|sqlite3
  --help

Exit codes: 0 counts compared (differences are reported, not failures), 1 a step failed,
2 bad usage, 3 no backup found, 4 no usable engine, 5 restored copy failed integrity_check,
77 refused (root).
Environment (tests): BIRDBRAIN_HOME, BB_COMPOSE_FILE, BB_DOCKER, BB_SUDO, BB_TEST_UID.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --engine) [ $# -ge 2 ] || { echo "--engine needs a value" >&2; exit 2; }; ENGINE="$2"; shift ;;
    --engine=*) ENGINE="${1#--engine=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$ENGINE" in auto|docker|sqlite3) ;; *) echo "bad --engine: $ENGINE" >&2; exit 2 ;; esac

log() { printf '==> %s\n' "$*" >&2; }
die() { echo "ERROR: $1" >&2; exit "${2:-1}"; }

uid="${BB_TEST_UID:-$(id -u)}"
if [ "$uid" -eq 0 ]; then
  echo "REFUSED: run this as your normal user, not root. The script calls sudo itself for the few" >&2
  echo "         commands that need it (Docker socket, root-owned temp folder/backup volume) and says why." >&2
  exit 77
fi

# priv CMD...: run with sudo only when needed (test hook BB_SUDO="" disables sudo entirely).
priv() {
  if [ -z "$SUDO" ]; then "$@"; else "$SUDO" -n "$@"; fi
}
# dock ARGS...: docker, through sudo only when the socket is not reachable directly.
# compose.yml has env_file: /opt/birdbrain/.env (root, 0600): even a docker-group member needs sudo to
# let compose read it, so that case is treated as "needs sudo" too.
if "$DOCKER" info >/dev/null 2>&1 && { [ ! -e "${BIRDBRAIN_HOME}/.env" ] || [ -r "${BIRDBRAIN_HOME}/.env" ]; }; then DOCKER_NEEDS_SUDO=no; else DOCKER_NEEDS_SUDO=yes; fi
dock() { if [ "$DOCKER_NEEDS_SUDO" = yes ]; then priv "$DOCKER" "$@"; else "$DOCKER" "$@"; fi; }

# ---- the node:sqlite program for the docker engine ---------------------------------------
# Env: BACKUP_DIR and DATABASE_PATH come from compose.yml (/backups, /data/birdbrain.db);
# RESTORE_DIR is the temp folder bind-mounted at /restore. Prints TSV: "kind<TAB>name<TAB>value".
NODE_PROGRAM="$(cat <<'JS'
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs"), path = require("path");
const backupDir = process.env.BACKUP_DIR || "/backups";
const livePath = process.env.DATABASE_PATH || "/data/birdbrain.db";
const restoreDir = process.env.RESTORE_DIR || "/restore";
const isBackup = (f) => /\.(db|sqlite|sqlite3)$/.test(f) && !/-(wal|shm|journal)$/.test(f);
const files = fs.readdirSync(backupDir).filter(isBackup)
  .map((f) => ({ f, p: path.join(backupDir, f), m: fs.statSync(path.join(backupDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
if (files.length === 0) { console.log("nobackup\t" + backupDir + "\t0"); process.exit(3); }
const newest = files[0];
console.log("backup\t" + newest.f + "\t" + fs.statSync(newest.p).size);
console.log("backup_mtime\t" + new Date(newest.m).toISOString() + "\t");
const copy = path.join(restoreDir, "restore-test.db");
fs.copyFileSync(newest.p, copy);                       // the only write: into the temp folder
const counts = (db) => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const out = {};
  for (const n of names) out[n] = db.prepare('SELECT COUNT(*) AS c FROM "' + n.replace(/"/g, '""') + '"').get().c;
  return out;
};
const r = new DatabaseSync(copy);                       // read-write: this IS the restore
const check = r.prepare("PRAGMA integrity_check").all().map((x) => Object.values(x)[0]).join("; ");
console.log("integrity\t" + check + "\t");
if (check !== "ok") process.exit(5);
const restored = counts(r); r.close();
const live = new DatabaseSync(livePath, { readOnly: true });   // live: read-only handle
const liveCounts = counts(live); live.close();
for (const n of new Set([...Object.keys(liveCounts), ...Object.keys(restored)]).values())
  console.log("table\t" + n + "\t" + (liveCounts[n] ?? "-") + "\t" + (restored[n] ?? "-"));
fs.unlinkSync(copy);
JS
)"

# ---- pick the engine (verified at run time) ---------------------------------------------
pick_engine() {
  if [ "$ENGINE" = auto ] || [ "$ENGINE" = docker ]; then
    if command -v "$DOCKER" >/dev/null 2>&1 && [ -r "$COMPOSE_FILE" ]; then ENGINE=docker; return; fi
    [ "$ENGINE" = docker ] && die "engine docker: '$DOCKER' or $COMPOSE_FILE not available" 4
  fi
  if command -v sqlite3 >/dev/null 2>&1 && command -v "$DOCKER" >/dev/null 2>&1; then ENGINE=sqlite3; return; fi
  die "no usable engine: need docker + $COMPOSE_FILE (api image with node:sqlite) or the sqlite3 CLI + docker (to find the volumes)" 4
}
pick_engine
log "engine: $ENGINE"

TMP_PARENT="${BIRDBRAIN_HOME}/tmp"
if [ "$DRY_RUN" = 1 ]; then
  log "[dry-run] temp folder: mktemp -d ${TMP_PARENT}/restore-test.XXXXXX (owner 1000:1000 for the api container; removed on exit)"
  if [ "$ENGINE" = docker ]; then
    log "[dry-run] docker compose -f ${COMPOSE_FILE} run --rm --no-deps -T -e RESTORE_DIR=/restore -v <tmp>:/restore api node --disable-warning=ExperimentalWarning -e '<node:sqlite program>'"
    log "[dry-run]   the program: newest backup in /backups -> copy to /restore/restore-test.db -> PRAGMA integrity_check"
    log "[dry-run]   -> COUNT(*) per table on the copy and on /data/birdbrain.db opened { readOnly: true } -> unlink the copy"
  else
    log "[dry-run] docker volume inspect -f '{{.Mountpoint}}' ${BACKUP_VOLUME} / ${DATA_VOLUME}  (root-only paths)"
    log "[dry-run] sudo cp <newest backup> <tmp>/restore-test.db; sudo chown \$USER <tmp>/restore-test.db"
    log "[dry-run] sqlite3 <tmp>/restore-test.db 'PRAGMA integrity_check' + counts; sudo sqlite3 -readonly 'file:<live>?mode=ro' counts"
  fi
  log "[dry-run] print the side-by-side table; rm -rf <tmp>"
  log "[dry-run] never: docker compose down/restart, writes to /data, /backups or anything outside ${BIRDBRAIN_HOME}"
  exit 0
fi

# ---- temp folder, removed whatever happens ---------------------------------------------
TMP=""
# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  rc=$?
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    if ! rm -rf "$TMP" 2>/dev/null; then priv rm -rf "$TMP" || log "WARNING: could not remove $TMP; remove it by hand"; fi
    [ -d "$TMP" ] || log "removed temp folder $TMP"
  fi
  exit "$rc"
}
trap cleanup EXIT

NEED_SUDO=no
if [ -n "$SUDO" ] && { [ ! -w "$BIRDBRAIN_HOME" ] || [ "$ENGINE" = sqlite3 ] || [ "$DOCKER_NEEDS_SUDO" = yes ]; }; then
  NEED_SUDO=yes
  why="the temp folder under root-owned ${BIRDBRAIN_HOME}"
  [ "$ENGINE" = sqlite3 ] && why="$why, reading the root-only backup/data volume paths"
  [ "$DOCKER_NEEDS_SUDO" = yes ] && why="$why, docker compose (the socket and/or the root-only .env it reads)"
  log "sudo is needed for: ${why}. Nothing else; the live database and container are not written to."
  "$SUDO" -v || die "sudo not available; cannot continue" 1
fi

if [ -w "$BIRDBRAIN_HOME" ] || [ -w "$TMP_PARENT" ] 2>/dev/null; then
  mkdir -p "$TMP_PARENT"; TMP="$(mktemp -d "${TMP_PARENT}/restore-test.XXXXXX")"
else
  priv install -d -m 0755 "$TMP_PARENT"
  TMP="$(priv mktemp -d "${TMP_PARENT}/restore-test.XXXXXX")"
fi
if [ "$ENGINE" = docker ]; then
  # the api container runs as 1000:1000 (compose.yml) and must write its copy here
  if [ "$NEED_SUDO" = yes ]; then priv chown 1000:1000 "$TMP"; else chown 1000:1000 "$TMP" 2>/dev/null || chmod 1777 "$TMP"; fi
fi
log "temp folder: $TMP"

# leftovers from an interrupted earlier run are reported, not deleted
stale="$(find "$TMP_PARENT" -maxdepth 1 -name 'restore-test.*' ! -path "$TMP" 2>/dev/null | tr '\n' ' ')"
[ -z "$stale" ] || log "note: older temp folders exist (not ours, left alone): $stale"

# ---- run the engine; collect TSV rows ---------------------------------------------------
rows=""
if [ "$ENGINE" = docker ]; then
  set +e
  rows="$(dock compose -f "$COMPOSE_FILE" run --rm --no-deps -T -e RESTORE_DIR=/restore -v "${TMP}:/restore" \
            api node --disable-warning=ExperimentalWarning -e "$NODE_PROGRAM")"
  rc=$?
  set -e
  case "$rc" in
    0) ;;
    3) echo "No backup found in the ${BACKUP_VOLUME} volume (/backups in the container). Nothing to test."; exit 3 ;;
    5) printf '%s\n' "$rows"; die "restored copy FAILED PRAGMA integrity_check (see above)" 5 ;;
    *) printf '%s\n' "$rows"; die "docker compose run failed with exit $rc" 1 ;;
  esac
else
  bdir="$(dock volume inspect -f '{{.Mountpoint}}' "$BACKUP_VOLUME")" || die "volume $BACKUP_VOLUME not found" 1
  ddir="$(dock volume inspect -f '{{.Mountpoint}}' "$DATA_VOLUME")" || die "volume $DATA_VOLUME not found" 1
  newest="$(priv find "$bdir" -maxdepth 1 -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -printf '%T@ %p\n' | sort -rn | head -n1 | cut -d' ' -f2-)"
  if [ -z "$newest" ]; then echo "No backup found in $bdir. Nothing to test."; exit 3; fi
  size="$(priv stat -c %s "$newest")"; mtime="$(priv stat -c %y "$newest")"
  rows="backup	$(basename "$newest")	$size"$'\n'"backup_mtime	$mtime	"$'\n'
  priv cp "$newest" "$TMP/restore-test.db"; priv chown "$(id -u)" "$TMP/restore-test.db"
  check="$(sqlite3 "$TMP/restore-test.db" 'PRAGMA integrity_check' | paste -sd ';')"
  rows+="integrity	$check	"$'\n'
  [ "$check" = ok ] || { printf '%s' "$rows"; die "restored copy FAILED PRAGMA integrity_check" 5; }
  tables_sql="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  declare -A livec restc
  while IFS= read -r t; do [ -n "$t" ] && restc[$t]="$(sqlite3 "$TMP/restore-test.db" "SELECT COUNT(*) FROM \"$t\"")"; done < <(sqlite3 "$TMP/restore-test.db" "$tables_sql")
  live="$ddir/birdbrain.db"
  while IFS= read -r t; do [ -n "$t" ] && livec[$t]="$(priv sqlite3 -readonly "$live" "SELECT COUNT(*) FROM \"$t\"")"; done < <(priv sqlite3 -readonly "$live" "$tables_sql")
  for t in $(printf '%s\n' "${!livec[@]}" "${!restc[@]}" | sort -u); do
    rows+="table	$t	${livec[$t]:--}	${restc[$t]:--}"$'\n'
  done
  rm -f "$TMP/restore-test.db"
fi

# ---- render --------------------------------------------------------------------------------
echo
echo "Birdbrain backup restore test   $(date -u +%Y-%m-%dT%H:%MZ)   engine: $ENGINE"
printf '%s\n' "$rows" | awk -F'\t' '
  $1=="backup"       { printf "Newest backup : %s (%d bytes)\n", $2, $3 }
  $1=="backup_mtime" { printf "Backup time   : %s\n", $2 }
  $1=="integrity"    { printf "Integrity     : %s\n", $2 }
'
echo
printf '%-32s %12s %12s  %s\n' "table" "live" "restored" "note"
printf '%-32s %12s %12s  %s\n' "-----" "----" "--------" "----"
diffs=0
while IFS=$'\t' read -r kind name l r; do
  [ "$kind" = table ] || continue
  note=""
  if [ "$l" = "-" ] || [ "$r" = "-" ]; then note="missing on one side"; diffs=$((diffs+1))
  elif [ "$l" != "$r" ]; then note="differs by $((l - r)) (live - restored; expected if rows changed since the backup)"; diffs=$((diffs+1)); fi
  printf '%-32s %12s %12s  %s\n' "$name" "$l" "$r" "$note"
done <<< "$rows"
echo
if [ "$diffs" -eq 0 ]; then echo "RESULT: restore OK, all table counts match live."
else echo "RESULT: restore OK (integrity ok); $diffs table(s) differ from live - normal if the backup is older than the last writes; investigate if a table is missing."; fi
exit 0
