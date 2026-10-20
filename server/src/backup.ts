/**
 * Nightly backup entry point. Run inside the container: node dist/backup.js
 * Settings (all optional): DATABASE_PATH, BACKUP_DIR, BACKUP_RETENTION_DAYS (14),
 * BACKUP_MAX_BYTES (5 GiB hard cap on the backup folder; oldest deleted first).
 */
import { DEFAULT_MAX_BYTES, DEFAULT_RETENTION_DAYS, envInt, runBackup } from './backup-lib.js';

runBackup({
  dbPath: process.env.DATABASE_PATH ?? '/data/birdbrain.db',
  dir: process.env.BACKUP_DIR ?? '/backups',
  retentionDays: envInt(process.env.BACKUP_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
  maxBytes: envInt(process.env.BACKUP_MAX_BYTES, DEFAULT_MAX_BYTES),
});
