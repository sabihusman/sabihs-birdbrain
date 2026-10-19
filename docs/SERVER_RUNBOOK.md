# Server runbook: `scripts/server/`

Two scripts for the Birdbrain host (95.216.159.93, Ubuntu, shared with other
projects that must never be touched, restarted or exposed). Both are **written
here and run only by hand on the server**; nothing in CI or in the app calls
them. Both are idempotent, refuse to run as root, and touch nothing outside
`/opt/birdbrain` (plus a temp folder under `/opt/birdbrain/tmp/`).

| Script | What it does | Writes | Needs |
| --- | --- | --- | --- |
| `update-planner.sh` | Lists upgradable apt packages grouped security / kernel / docker / nginx / openssl / other, says whether a reboot would be needed, writes a report. Installs nothing. | one report file under `/opt/birdbrain/reports/` | a normal user; apt |
| `backup-restore-test.sh` | Restores the newest database backup into a throwaway copy, checks its integrity, compares row counts per table with the live database (opened read-only), prints a table, deletes the copy. | a temp folder under `/opt/birdbrain/tmp/`, removed on exit | a normal user with `sudo`; docker (+ the api image) or the `sqlite3` CLI |

Getting the scripts onto the server (they are not part of the image): copy the
folder with `scp -r scripts/server birdbrain@host:~/` or `git pull` a checkout
in your home directory. Run them from anywhere; paths are absolute.

Self-test (no server, no docker, no sudo, no root): `bash scripts/server/test.sh`
(runs `bash -n`, `shellcheck` when installed, and 47 checks against a fake tree
in a temp dir; CI runs it too).

---

## 1. `update-planner.sh` (read-only)

### Commands

```sh
scripts/server/update-planner.sh --dry-run   # shows what it would read and where the report goes
scripts/server/update-planner.sh             # plan + report
scripts/server/update-planner.sh --report -  # print only, write no file
```

What it reads: `apt list --upgradable` (falls back to `apt-get -s upgrade`,
simulation only), `/var/run/reboot-required` and `.pkgs`, and `needrestart -b`
when that package is installed (it is optional; the report says when it is not).
It never runs `apt-get install/upgrade`, `dpkg`, `systemctl` or `docker`.

### Expected output

```
Birdbrain host update plan   2026-10-19 20:24Z   host: vm
Read-only: nothing was installed, upgraded, restarted or reloaded by this script.

Upgradable packages: 7
[security] 2
  openssl                                  3.0.13-0ubuntu3.3            -> 3.0.13-0ubuntu3.4  (noble-security)
  libssl3t64                               3.0.13-0ubuntu3.3            -> 3.0.13-0ubuntu3.4  (noble-security)
[kernel] 1
  linux-image-generic                      6.8.0-40.40                  -> 6.8.0-45.45  (noble-updates)
[docker] 2
  docker-ce                                5:27.2.0-1~ubuntu.24.04~noble -> 5:27.3.1-1~ubuntu.24.04~noble  (noble)
  containerd.io                            1.7.21-1                     -> 1.7.22-1  (noble)
[nginx] 1
  nginx                                    1.24.0-2ubuntu7              -> 1.24.0-2ubuntu7.1  (noble-updates)
[openssl] 0
[other] 1
  curl                                     8.5.0-2ubuntu10.3            -> 8.5.0-2ubuntu10.4  (noble-updates)

Reboot needed: yes - a kernel package would be upgraded (reboot after installing)
needrestart: not installed or no output (install it on the host for service-restart hints; optional)

What to do (by hand, only after reading SERVER_RUNBOOK.md):
  - docker/containerd upgrades restart EVERY container on this host, including the other projects' - schedule it.
  - nginx upgrade reloads/restarts nginx for ALL sites - run verify.sh baseline first, check after.
  - a reboot takes every project on the host down for ~1-2 min - announce it.
  - security first: sudo apt-get install --only-upgrade <pkgs> (not run by this script).
==> report written: /opt/birdbrain/reports/update-plan-2026-10-19.txt
```

Grouping rules: anything from a `*-security` suite is **security** (so
`libssl3t64` from `noble-security` counts there, not under openssl); then by
name: `linux-image/headers/modules/generic/hwe/firmware` → kernel,
`docker*`/`containerd*`/`runc` → docker, `nginx*`/`libnginx*` → nginx,
`openssl`/`libssl*`/`ca-certificates` → openssl; the rest → other.
"Reboot needed: yes" when `/var/run/reboot-required` exists, when a kernel
package is in the list, or when `needrestart` reports a newer installed kernel.

The report is `update-plan-<UTC date>.txt`, written atomically and overwritten
on a rerun the same day (one file per day; idempotent).

### Failures

| Symptom | Meaning | Do |
| --- | --- | --- |
| `REFUSED: do not run the update planner as root` (exit 77) | run with sudo or as root | run it as your normal user; nothing in it needs root |
| `apt/apt-get not found or not usable` (exit 3) | not an apt host, or `apt` missing from PATH | nothing to plan; check `which apt` |
| `report NOT written: /opt/birdbrain/reports is not writable` | `/opt/birdbrain` is root-owned (as installed by `setup.sh`) | the plan was still printed; once, as root: `install -d -m 0755 -o <you> /opt/birdbrain/reports`, or use `--report -` |
| `Upgradable packages: 0` but you expected some | apt lists are stale | `sudo apt-get update` (a metadata refresh only; still not run by the script), then rerun |
| Reboot "yes" but the kernel group is empty | `/var/run/reboot-required` is left from an earlier upgrade | it is real: the running kernel/libc is older than the installed one; plan the reboot |

Acting on the plan is manual and outside the script. Safe order on this shared
host: security packages first (`sudo apt-get install --only-upgrade <pkgs>`),
docker/containerd only in a window (every container on the host restarts),
nginx with `server/deploy/verify.sh baseline` before and `check` after, and a
reboot announced to the other projects' owners.

**Rollback:** nothing to roll back; the script is read-only. Delete the report
file if you do not want it (`rm /opt/birdbrain/reports/update-plan-<date>.txt`).

---

## 2. `backup-restore-test.sh`

### Where the backups are

`server/src/backup.ts` (run daily by `server/scripts/backup.sh` through
`docker exec birdbrain-api node dist/backup.js`) writes
`birdbrain-YYYYMMDDTHHMMSSZ.db` with `VACUUM INTO` into `BACKUP_DIR=/backups`,
which `compose.yml` maps to the named volume **`birdbrain-backups`**. The live
database is `/data/birdbrain.db` in the **`birdbrain-data`** volume. On the host
both live under `/var/lib/docker/volumes/<name>/_data` (root-only). The script
takes the newest `*.db` / `*.sqlite` / `*.sqlite3` by modification time and
ignores `-wal`/`-shm`/`-journal` files.

### Engines (checked at run time; `--engine auto` prefers docker)

- **docker** (default when `docker` and `/opt/birdbrain/compose.yml` exist):
  `docker compose -f /opt/birdbrain/compose.yml run --rm --no-deps -T
  -e RESTORE_DIR=/restore -v <tmp>:/restore api node -e '<program>'`.
  The one-off container is the api image (Node 22 with `node:sqlite`), mounts the
  same two volumes as the live service, publishes **no ports** (`run` never does
  without `--service-ports`) and exits when the program ends; the live
  `birdbrain-api` container is not stopped, restarted or exec'd into. In the
  program the backup is copied to `/restore/restore-test.db`, opened read-write
  (that is the restore), `PRAGMA integrity_check`ed and counted; the live file is
  opened with `new DatabaseSync('/data/birdbrain.db', { readOnly: true })`, which
  makes every write fail at the SQLite level.
- **sqlite3** (`--engine sqlite3`, or auto when docker compose is unusable but
  `sqlite3` is on the host): `docker volume inspect` gives the two mount points;
  `sudo cp` the newest backup into the temp folder, `sqlite3` the copy
  (integrity + counts), and `sudo sqlite3 -readonly <live>` for the live counts.
  Not verified on the host: whether `sqlite3` is installed there (`which sqlite3`).

### Commands

```sh
scripts/server/backup-restore-test.sh --dry-run          # plan only; no sudo, no docker, nothing created
scripts/server/backup-restore-test.sh                    # the test
scripts/server/backup-restore-test.sh --engine sqlite3   # force the CLI engine
```

Why `sudo` appears (the script prints the exact reason before `sudo -v`):
`/opt/birdbrain` is root-owned, so the temp folder under `/opt/birdbrain/tmp/`
is created and removed with sudo; `compose.yml` reads `/opt/birdbrain/.env`
(root, 0600), so `docker compose` must run as root even for docker-group
members; and the sqlite3 engine reads the root-only volume paths. That is all it
is used for. Running the script itself as root is refused (exit 77).

### Expected output

```
==> engine: docker
==> sudo is needed for: the temp folder under root-owned /opt/birdbrain, docker compose (the socket and/or the root-only .env it reads). Nothing else; the live database and container are not written to.
==> temp folder: /opt/birdbrain/tmp/restore-test.cUcicq

Birdbrain backup restore test   2026-10-19T20:24Z   engine: docker
Newest backup : birdbrain-20261019T031500Z.db (16384 bytes)
Backup time   : 2026-10-19T03:15:00.685Z
Integrity     : ok

table                                    live     restored  note
-----                                    ----     --------  ----
ask_cache                                   0            0
session                                     0            0
user                                        5            4  differs by 1 (live - restored; expected if rows changed since the backup)

RESULT: restore OK (integrity ok); 1 table(s) differ from live - normal if the backup is older than the last writes; investigate if a table is missing.
==> removed temp folder /opt/birdbrain/tmp/restore-test.cUcicq
```

With no backup file at all:

```
No backup found in the birdbrain-backups volume (/backups in the container). Nothing to test.
```
(exit 3; the temp folder is still removed).

### Failures

| Symptom / exit | Meaning | Do |
| --- | --- | --- |
| `REFUSED: run this as your normal user` (77) | started as root | rerun as yourself; it sudoes what it must |
| `No backup found` (3) | the backups volume is empty | the cron job in `server/scripts/backup.sh` is not running: `sudo crontab -l`, `sudo docker exec birdbrain-api node --disable-warning=ExperimentalWarning dist/backup.js` once by hand, then rerun |
| `no usable engine` (4) | neither `docker`+compose file nor `sqlite3` | `which docker sqlite3`; `ls /opt/birdbrain/compose.yml` |
| `restored copy FAILED PRAGMA integrity_check` (5) | the newest backup is corrupt | keep the file for inspection, run the backup job by hand and test again; if that also fails, the live DB may be damaged: `sudo docker exec birdbrain-api node -e "..."` with `PRAGMA integrity_check` on `/data/birdbrain.db` read-only |
| `docker compose run failed with exit N` (1) | image pull/auth, volume or compose problem | the container's stderr is printed above the line; usual causes: image not pulled yet (`BIRDBRAIN_IMAGE_TAG` in `.env` points at a tag that does not exist), or `.env` unreadable (not using sudo) |
| `sudo not available` (1) | no sudo rights | use `--dry-run` to see the plan, or ask the host owner to run it |
| a table shows `-` on one side | schema differs between backup and live (new migration since the backup, or an old image) | expected right after a deploy that adds a table; otherwise check `BIRDBRAIN_IMAGE_TAG` and when the backup was taken |
| counts differ | normal: rows written since the backup time | compare `Backup time` with now; a difference that *shrinks* live below the backup is worth a look (deletions) |
| `WARNING: could not remove <tmp>` | cleanup failed (sudo expired) | `sudo rm -rf /opt/birdbrain/tmp/restore-test.*`; the script also lists stale folders at the next run and leaves them alone |

### Guarantees (how each rule is enforced)

- Live DB never written: docker engine opens it `{ readOnly: true }`; sqlite3
  engine uses `sqlite3 -readonly`. The backup files are only read (`copyFileSync`
  / `cp`).
- Live container never touched: only `docker compose run --rm --no-deps -T`
  (a separate one-off container) and `docker volume inspect`. No `down`, `stop`,
  `restart`, `up`, `exec`, no `systemctl`. The test harness's fake docker exits
  99 on any of those subcommands.
- Nothing exposed: `run` publishes no ports; the copy is a plain file in the
  temp folder, never served.
- Nothing outside `/opt/birdbrain`: the only path created is
  `mktemp -d /opt/birdbrain/tmp/restore-test.XXXXXX`, removed by an `EXIT` trap on
  every exit path (success, no-backup, failure, Ctrl-C).
- Idempotent: every run uses a fresh temp folder and leaves none; the report of
  stale folders is informational.

**Rollback:** nothing to roll back; the only artefact is the temp folder, which
the script removes. If it was interrupted hard: `sudo rm -rf /opt/birdbrain/tmp/restore-test.*`.

---

## 3. Not verified on the live server (do this the first time, read-only)

```sh
which sqlite3 needrestart                     # which engine / hints are available
sudo docker volume ls | grep birdbrain          # birdbrain-data, birdbrain-backups
sudo docker compose -f /opt/birdbrain/compose.yml run --rm --no-deps -T api node -e 'console.log(require("fs").readdirSync("/backups"))'
ls -ld /opt/birdbrain /opt/birdbrain/tmp        # ownership (root) -> explains the sudo prompts
```

The backup path (`/backups` → `birdbrain-backups`) and the file name pattern
come from `server/src/backup.ts` and `server/compose.yml`, not from a look at
the host. If backups were ever configured elsewhere, set
`BB_BACKUP_VOLUME` / `BB_DATA_VOLUME` (sqlite3 engine) or `BACKUP_DIR` (docker
engine, via compose) accordingly.
