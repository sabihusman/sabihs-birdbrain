/**
 * Consistent SQLite backup with VACUUM INTO, plus two pruning rules:
 * - retention: backups older than `retentionDays` are deleted (the privacy note
 *   promises "removed within 14 days");
 * - hard size cap: before writing, the oldest backups are deleted until the
 *   existing ones plus the new one (estimated by the live file's size) fit in
 *   `maxBytes`. Default 5 GiB. The newest existing backup is never deleted for
 *   the cap unless the new one alone would not fit otherwise.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_RETENTION_DAYS = 14;
export const DEFAULT_MAX_BYTES = 5 * 1024 ** 3;
const NAME = /^birdbrain-\d{8}T\d{6}Z\.db$/;

export interface BackupOptions {
  dbPath: string;
  dir: string;
  retentionDays?: number;
  maxBytes?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface BackupResult {
  target: string;
  prunedForSpace: string[];
  prunedByAge: string[];
}

interface Entry {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

function listBackups(dir: string): Entry[] {
  const out: Entry[] = [];
  for (const name of readdirSync(dir)) {
    if (!NAME.test(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    out.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
  }
  // Oldest first by the timestamp in the name (mtime can lie after a copy).
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function stampFor(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function runBackup(opts: BackupOptions): BackupResult {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));

  mkdirSync(opts.dir, { recursive: true });

  // Hard cap: make room for the new backup first, oldest out first.
  const estimate = statSync(opts.dbPath).size;
  const existing = listBackups(opts.dir);
  const prunedForSpace: string[] = [];
  let used = existing.reduce((sum, e) => sum + e.size, 0);
  while (existing.length > 0 && used + estimate > maxBytes) {
    const oldest = existing.shift()!;
    unlinkSync(oldest.path);
    used -= oldest.size;
    prunedForSpace.push(oldest.name);
    log(`[backup] pruned ${oldest.name} (size cap ${maxBytes} bytes)`);
  }
  if (used + estimate > maxBytes) {
    log(`[backup] warning: a single backup (${estimate} bytes) exceeds BACKUP_MAX_BYTES=${maxBytes}`);
  }

  const target = join(opts.dir, `birdbrain-${stampFor(now())}.db`);
  const db = new DatabaseSync(opts.dbPath);
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  log(`[backup] wrote ${target}`);

  // Retention: the promise is "removed within 14 days".
  const cutoff = now() - retentionDays * 86_400_000;
  const prunedByAge: string[] = [];
  for (const e of listBackups(opts.dir)) {
    if (e.path === target) continue;
    if (e.mtimeMs < cutoff) {
      unlinkSync(e.path);
      prunedByAge.push(e.name);
      log(`[backup] pruned ${e.name}`);
    }
  }
  return { target, prunedForSpace, prunedByAge };
}

/** Parse a positive integer env value; anything else gives the default. */
export function envInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
