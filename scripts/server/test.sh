#!/usr/bin/env bash
# shellcheck disable=SC2016  # bash -c snippets take $1 $2 as arguments on purpose
# Tests for scripts/server/*.sh. Needs bash and node >= 22 (node:sqlite); no docker, no sudo,
# no root, nothing outside a temp dir. Run: bash scripts/server/test.sh
#   - bash -n (and shellcheck when installed) on both scripts
#   - update-planner: root refused, --dry-run writes nothing, grouping + reboot detection + report file
#   - backup-restore-test: root refused, --dry-run runs nothing, no-backup exit 3, full run with a
#     fake docker that executes the node:sqlite program locally, temp folder removed, live DB unchanged,
#     and the fake docker rejects any down/restart/stop
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0; pass=0
export BB_TEST_UID=1000   # the scripts refuse root; CI and sandboxes may run as root
PLANNER="$HERE/update-planner.sh"; RESTORE="$HERE/backup-restore-test.sh"

ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1"; }
# check NAME CMD...   : passes when CMD exits 0
check() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi; }
# exits NAME CODE CMD...: passes when CMD exits with CODE
exits() { local n="$1" want="$2" rc=0; shift 2; "$@" >/dev/null 2>&1 || rc=$?; if [ "$rc" -eq "$want" ]; then ok "$n"; else bad "$n (exit $rc, wanted $want)"; fi; }
# has NAME FILE REGEX : passes when FILE has a line matching REGEX (grep -E)
has()    { if grep -Eq -- "$3" "$2"; then ok "$1"; else bad "$1"; fi; }
hasnot() { if ! grep -Eq -- "$3" "$2"; then ok "$1"; else bad "$1"; fi; }
empty_dir() { [ -z "$(ls -A "$1" 2>/dev/null)" ]; }
count_files() { [ "$(find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)" -eq "$2" ]; }

echo "== syntax"
for f in "$PLANNER" "$RESTORE" "$HERE/test.sh" "$HERE/testdata/fake-docker" "$HERE/testdata/fake-sudo"; do
  check "bash -n $(basename "$f")" bash -n "$f"
done
if command -v shellcheck >/dev/null 2>&1; then
  check "shellcheck" shellcheck -S style "$PLANNER" "$RESTORE" "$HERE/test.sh" "$HERE/testdata/fake-docker" "$HERE/testdata/fake-sudo"
else
  echo "  skip shellcheck (not installed)"
fi

echo "== update-planner"
H="$T/opt"; mkdir -p "$H" "$T/run"
export BIRDBRAIN_HOME="$H" BB_RUN_DIR="$T/run" BB_APT_LIST_FILE="$HERE/testdata/apt-list-upgradable.txt"
BB_TEST_UID=0 exits "refuses root (77)" 77 bash "$PLANNER"
exits "--help exits 0" 0 bash "$PLANNER" --help
exits "bad option exits 2" 2 bash "$PLANNER" --bogus
exits "--dry-run exits 0" 0 bash "$PLANNER" --dry-run
check "--dry-run writes nothing" test ! -e "$H/reports"
bash "$PLANNER" >"$T/plan.txt" 2>/dev/null
has "groups: security 2" "$T/plan.txt" '^\[security\] 2'
has "groups: kernel 1"   "$T/plan.txt" '^\[kernel\] 1'
has "groups: docker 2"   "$T/plan.txt" '^\[docker\] 2'
has "groups: nginx 1"    "$T/plan.txt" '^\[nginx\] 1'
has "groups: openssl 0 (libssl counted as security)" "$T/plan.txt" '^\[openssl\] 0'
has "groups: other 1"    "$T/plan.txt" '^\[other\] 1'
has "kernel line lists old -> new" "$T/plan.txt" '^  linux-image-generic +6\.8\.0-40\.40 +-> 6\.8\.0-45\.45'
has "reboot yes (kernel)" "$T/plan.txt" '^Reboot needed: yes'
rep="$H/reports/update-plan-$(date -u +%Y-%m-%d).txt"
check "report file written" test -s "$rep"
bash "$PLANNER" >/dev/null 2>&1
check "idempotent: second run, still one report file" count_files "$H/reports" 1
: > "$T/empty.txt"; touch "$T/run/reboot-required"; echo linux-base > "$T/run/reboot-required.pkgs"
BB_APT_LIST_FILE="$T/empty.txt" bash "$PLANNER" --report - >"$T/plan2.txt" 2>/dev/null
has "no packages: total 0" "$T/plan2.txt" '^Upgradable packages: 0'
has "reboot yes (reboot-required file)" "$T/plan2.txt" 'reboot-required exists'
check "--report - writes no file" count_files "$H/reports" 1
unset BB_RUN_DIR BB_APT_LIST_FILE

echo "== backup-restore-test"
F="$T/fake"; mkdir -p "$F/volumes/backups" "$F/volumes/data" "$F/bin"
cp "$HERE/testdata/fake-docker" "$F/bin/docker"; cp "$HERE/testdata/fake-sudo" "$F/bin/sudo"; chmod +x "$F/bin/"*
export FAKE_HOME="$F" FAKE_LOG="$T/docker.log" BB_DOCKER="$F/bin/docker" BB_SUDO="$F/bin/sudo"
touch "$H/compose.yml"; : > "$FAKE_LOG"
mk() { node --disable-warning=ExperimentalWarning -e '
  const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.argv[1]);
  d.exec("CREATE TABLE user(id INTEGER PRIMARY KEY, email TEXT); CREATE TABLE session(id INTEGER PRIMARY KEY); CREATE TABLE ask_cache(k TEXT)");
  const n = Number(process.argv[2]); for (let i = 0; i < n; i++) d.prepare("INSERT INTO user(email) VALUES (?)").run("u" + i);
  d.exec("INSERT INTO session DEFAULT VALUES"); d.close();' "$1" "$2"; }
mk "$F/volumes/data/birdbrain.db" 5
BB_TEST_UID=0 exits "refuses root (77)" 77 bash "$RESTORE"
exits "--help exits 0" 0 bash "$RESTORE" --help
exits "bad --engine exits 2" 2 bash "$RESTORE" --engine foo
exits "--dry-run exits 0" 0 bash "$RESTORE" --dry-run
check "--dry-run runs no docker compose, creates no tmp" bash -c '! grep -q compose "$FAKE_LOG" && [ ! -e "$1/tmp" ]' _ "$H"
exits "no backup -> exit 3" 3 bash "$RESTORE"
check "no backup: temp folder removed" empty_dir "$H/tmp"
mk "$F/volumes/backups/birdbrain-20261018T031500Z.db" 3; sleep 1
mk "$F/volumes/backups/birdbrain-20261019T031500Z.db" 4
sum_before="$(cksum < "$F/volumes/data/birdbrain.db")"
: > "$FAKE_LOG"
exits "full run exit 0" 0 bash -c 'bash "$1" >"$2" 2>"$2.err"' _ "$RESTORE" "$T/out.txt"
has "picked the newest backup" "$T/out.txt" '^Newest backup : birdbrain-20261019T031500Z\.db'
has "integrity ok" "$T/out.txt" '^Integrity     : ok'
has "user: live 5, restored 4, differs" "$T/out.txt" '^user +5 +4 +differs by 1'
has "session: 1 1 match" "$T/out.txt" '^session +1 +1 *$'
has "ask_cache: 0 0" "$T/out.txt" '^ask_cache +0 +0 *$'
has "result line: 1 table differs" "$T/out.txt" '^RESULT: restore OK \(integrity ok\); 1 table'
check "live DB unchanged" test "$(cksum < "$F/volumes/data/birdbrain.db")" = "$sum_before"
check "backups untouched (2 files)" count_files "$F/volumes/backups" 2
check "temp folder removed" empty_dir "$H/tmp"
has "docker: compose run --rm --no-deps -T" "$FAKE_LOG" 'compose -f .* run --rm --no-deps -T '
hasnot "docker: no --service-ports" "$FAKE_LOG" 'service-ports'
hasnot "docker: never down/restart/stop/up" "$FAKE_LOG" ' (down|restart|stop|up) '
hasnot "no sudo when the tree is writable" "$FAKE_LOG" '^sudo'
exits "idempotent: second full run exit 0" 0 bash "$RESTORE"
check "temp folder removed again" empty_dir "$H/tmp"
if command -v sqlite3 >/dev/null 2>&1; then
  : > "$FAKE_LOG"
  exits "sqlite3 engine exit 0" 0 bash -c 'bash "$1" --engine sqlite3 >"$2" 2>&1' _ "$RESTORE" "$T/out3.txt"
  has "sqlite3 engine: user 5 4" "$T/out3.txt" '^user +5 +4 '
  has "sqlite3 engine: live opened -readonly via sudo" "$FAKE_LOG" 'sudo -n sqlite3 -readonly'
  check "sqlite3 engine: temp folder removed" empty_dir "$H/tmp"
else
  echo "  skip sqlite3 engine (sqlite3 CLI not installed)"
fi

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
