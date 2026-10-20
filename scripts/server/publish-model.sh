#!/usr/bin/env bash
# Publish the BirdNET model files to the Birdbrain server, where Nginx serves them
# from /models/<version>/ (DECISIONS.md #56). Run from the repo root on the PC:
#
#   scripts/server/publish-model.sh --dry-run        # plan only, nothing copied
#   scripts/server/publish-model.sh                  # publish (asks nothing)
#
# What it does, in order:
#   1. checks the local files against models/<version>/SHA256SUMS;
#   2. compares them with what the server already has (sha256 per file). If every
#      file matches, it stops: nothing to do (so re-running is safe and cheap);
#   3. streams a tar of the folder into a temp folder next to the target on the
#      server, verifies the manifest there, then swaps it into place with mv and
#      removes the previous folder. A failed or interrupted run leaves the live
#      folder untouched;
#   4. sets root:root, 0755 on folders and 0644 on files, and prints the result.
#
# Only /opt/birdbrain/models/ on the server is written. Nothing else is touched:
# no Nginx reload (the location is static), no container restart.
set -euo pipefail

VERSION="${MODEL_VERSION:-birdnet-v2.4}"
HOST="${BIRDBRAIN_SSH_HOST:-root@95.216.159.93}"
SRC=""
REMOTE_ROOT="${BIRDBRAIN_MODELS_DIR:-/opt/birdbrain/models}"
DRY_RUN=0
SSH_BIN="${SSH_BIN:-}"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOT'

Options:
  --dry-run            print the plan and the local/remote comparison, copy nothing
  --version <name>     model folder name (default birdnet-v2.4, or $MODEL_VERSION)
  --src <dir>          local folder (default models/<version>)
  --host <user@host>   target (default root@95.216.159.93, or $BIRDBRAIN_SSH_HOST)
  --remote-root <dir>  parent folder on the server (default /opt/birdbrain/models)
  -h, --help           this text
EOT
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --src) SRC="${2:?--src needs a value}"; shift ;;
    --host) HOST="${2:?--host needs a value}"; shift ;;
    --remote-root) REMOTE_ROOT="${2:?--remote-root needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SRC="${SRC:-models/$VERSION}"
REMOTE_DIR="$REMOTE_ROOT/$VERSION"
MANIFEST="$SRC/SHA256SUMS"

# Git Bash on Windows ships an ssh that cannot read the user's keys; Windows OpenSSH can.
if [ -z "$SSH_BIN" ]; then
  if [ -x /c/Windows/System32/OpenSSH/ssh.exe ]; then
    SSH_BIN=/c/Windows/System32/OpenSSH/ssh.exe
  else
    SSH_BIN=ssh
  fi
fi
ssh_run() { "$SSH_BIN" -o BatchMode=yes "$HOST" "$@"; }

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[ -d "$SRC" ] || die "no such folder: $SRC"
[ -f "$MANIFEST" ] || die "no manifest: $MANIFEST (create it with: cd $SRC && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | xargs sha256sum > SHA256SUMS)"

local_files="$(cd "$SRC" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort)"
file_count="$(printf '%s\n' "$local_files" | grep -c .)"
total_bytes="$(cd "$SRC" && printf '%s\n' "$local_files" | xargs stat -c %s | awk '{s += $1} END {print s + 0}')"

say "plan"
echo "    local folder : $SRC ($file_count files, $total_bytes bytes)"
echo "    manifest     : $MANIFEST"
echo "    target       : $HOST:$REMOTE_DIR"
echo "    ssh          : $SSH_BIN"

say "checking the local files against the manifest"
(cd "$SRC" && sha256sum -c SHA256SUMS --quiet) || die "local files do not match $MANIFEST"
echo "    ok, $file_count files"

say "asking the server what it already has"
remote_state="$(ssh_run "if [ -d '$REMOTE_DIR' ]; then cd '$REMOTE_DIR' && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | xargs -r sha256sum; else echo '(absent)'; fi")"
if [ "$remote_state" = "(absent)" ]; then
  echo "    $REMOTE_DIR does not exist yet"
  remote_matches=0
else
  # Compare the server's hashes with the local manifest, ignoring the leading "*" marker.
  norm_local="$(cd "$SRC" && sed 's/ \*/  /' SHA256SUMS | LC_ALL=C sort)"
  norm_remote="$(printf '%s\n' "$remote_state" | sed 's/ \*/  /' | LC_ALL=C sort)"
  if [ "$norm_local" = "$norm_remote" ]; then
    remote_matches=1
    echo "    the server already has exactly these $file_count files"
  else
    remote_matches=0
    echo "    the server differs:"
    diff <(printf '%s\n' "$norm_local") <(printf '%s\n' "$norm_remote") | sed 's/^/      /' || true
  fi
fi

if [ "$remote_matches" = 1 ]; then
  say "nothing to do"
  exit 0
fi

if [ "$DRY_RUN" = 1 ]; then
  say "dry run: would create $REMOTE_DIR.new, verify it, then swap it into $REMOTE_DIR"
  exit 0
fi

say "copying (tar over ssh, $total_bytes bytes)"
tar -C "$SRC" -cf - . | ssh_run "
  set -eu
  mkdir -p '$REMOTE_ROOT'
  rm -rf '$REMOTE_DIR.new'
  mkdir -p '$REMOTE_DIR.new'
  tar -C '$REMOTE_DIR.new' -xf -
  cd '$REMOTE_DIR.new'
  sha256sum -c SHA256SUMS --quiet
  chown -R root:root '$REMOTE_DIR.new'
  find '$REMOTE_DIR.new' -type d -exec chmod 755 {} +
  find '$REMOTE_DIR.new' -type f -exec chmod 644 {} +
  rm -rf '$REMOTE_DIR.old'
  if [ -d '$REMOTE_DIR' ]; then mv '$REMOTE_DIR' '$REMOTE_DIR.old'; fi
  mv '$REMOTE_DIR.new' '$REMOTE_DIR'
  rm -rf '$REMOTE_DIR.old'
  echo \"    published \$(find '$REMOTE_DIR' -type f | wc -l) files, \$(du -sb '$REMOTE_DIR' | cut -f1) bytes\"
"

say "verifying what the server now serves"
ssh_run "cd '$REMOTE_DIR' && sha256sum -c SHA256SUMS --quiet && ls -la '$REMOTE_DIR' | head -5 && stat -c '%U:%G %a %n' '$REMOTE_DIR'"
say "done"
