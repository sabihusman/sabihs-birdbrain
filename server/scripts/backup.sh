#!/usr/bin/env bash
# Daily SQLite backup for the Birdbrain API. Install on the host as a root cron job, e.g.
#   15 3 * * * /opt/birdbrain/backup.sh >> /var/log/birdbrain-backup.log 2>&1
# Backups land in the birdbrain-backups Docker volume; retention is BACKUP_RETENTION_DAYS (default 14).
set -euo pipefail
docker exec birdbrain-api node --disable-warning=ExperimentalWarning dist/backup.js
