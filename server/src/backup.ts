/**
 * Consistent SQLite backup with VACUUM INTO, plus retention pruning.
 * Run inside the container: node dist/backup.js
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const dbPath = process.env.DATABASE_PATH ?? '/data/birdbrain.db';
const dir = process.env.BACKUP_DIR ?? '/backups';
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);

mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const target = join(dir, `birdbrain-${stamp}.db`);
const db = new DatabaseSync(dbPath);
try {
  db.prepare('VACUUM INTO ?').run(target);
} finally {
  db.close();
}
console.log(`[backup] wrote ${target}`);

const cutoff = Date.now() - retentionDays * 86_400_000;
for (const f of readdirSync(dir)) {
  if (!/^birdbrain-\d{8}T\d{6}Z\.db$/.test(f)) continue;
  const p = join(dir, f);
  if (statSync(p).mtimeMs < cutoff) {
    unlinkSync(p);
    console.log(`[backup] pruned ${f}`);
  }
}
