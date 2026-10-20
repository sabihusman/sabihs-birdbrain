import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_BYTES, DEFAULT_RETENTION_DAYS, envInt, runBackup, stampFor } from '../src/backup-lib.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-20T03:15:00Z');

let root: string;
let dbPath: string;
let dir: string;

function makeDb(rows: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run('x'.repeat(1000));
  db.close();
}

/** A fake old backup file of `size` bytes with the given age (both name and mtime). */
function oldBackup(ageDays: number, size: number): string {
  const ms = T0 - ageDays * DAY;
  const name = `birdbrain-${stampFor(ms)}.db`;
  const p = join(dir, name);
  writeFileSync(p, Buffer.alloc(size, 1));
  utimesSync(p, ms / 1000, ms / 1000);
  return name;
}

const names = () => readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
const quiet = () => {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bb-backup-'));
  dbPath = join(root, 'live.db');
  dir = join(root, 'backups');
  mkdirSync(dir);
  makeDb(50);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runBackup', () => {
  it('writes a consistent copy named by UTC timestamp and keeps recent backups', () => {
    const r = runBackup({ dbPath, dir, now: () => T0, log: quiet });
    expect(r.target).toBe(join(dir, 'birdbrain-20261020T031500Z.db'));
    const copy = new DatabaseSync(r.target, { readOnly: true });
    expect((copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(50);
    copy.close();
    expect(r.prunedForSpace).toEqual([]);
    expect(r.prunedByAge).toEqual([]);
  });

  it('deletes backups older than the retention window and keeps newer ones', () => {
    const old = oldBackup(15, 100);
    const edge = oldBackup(13, 100);
    const r = runBackup({ dbPath, dir, now: () => T0, log: quiet });
    expect(r.prunedByAge).toEqual([old]);
    expect(names()).toEqual([edge, 'birdbrain-20261020T031500Z.db'].sort());
  });

  it('enforces the hard size cap by deleting the oldest first, before writing', () => {
    const live = statSync(dbPath).size;
    const a = oldBackup(3, 1000);
    const b = oldBackup(2, 1000);
    const c = oldBackup(1, 1000);
    // Room for the new file plus two old ones only.
    const r = runBackup({ dbPath, dir, now: () => T0, maxBytes: live + 2500, log: quiet });
    expect(r.prunedForSpace).toEqual([a]);
    expect(names()).toEqual([b, c, 'birdbrain-20261020T031500Z.db'].sort());
  });

  it('keeps deleting until the new backup fits, even if that empties the folder', () => {
    const live = statSync(dbPath).size;
    const a = oldBackup(3, 1000);
    const b = oldBackup(2, 1000);
    const r = runBackup({ dbPath, dir, now: () => T0, maxBytes: live + 10, log: quiet });
    expect(r.prunedForSpace).toEqual([a, b]);
    expect(names()).toEqual(['birdbrain-20261020T031500Z.db']);
  });

  it('warns but still writes when one backup alone exceeds the cap', () => {
    const lines: string[] = [];
    runBackup({ dbPath, dir, now: () => T0, maxBytes: 10, log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes('exceeds BACKUP_MAX_BYTES'))).toBe(true);
    expect(names()).toEqual(['birdbrain-20261020T031500Z.db']);
  });

  it('ignores files that are not backups when pruning', () => {
    oldBackup(20, 100);
    writeFileSync(join(dir, 'notes.txt'), 'keep me');
    writeFileSync(join(dir, 'birdbrain-20200101T000000Z.db-wal'), Buffer.alloc(5000));
    runBackup({ dbPath, dir, now: () => T0, maxBytes: 1, log: quiet });
    const all = readdirSync(dir).sort();
    expect(all).toContain('notes.txt');
    expect(all).toContain('birdbrain-20200101T000000Z.db-wal');
    expect(names()).toEqual(['birdbrain-20261020T031500Z.db']);
  });
});

describe('env parsing', () => {
  it('uses defaults for missing, zero or garbage values', () => {
    expect(envInt(undefined, DEFAULT_RETENTION_DAYS)).toBe(14);
    expect(envInt('0', DEFAULT_MAX_BYTES)).toBe(5 * 1024 ** 3);
    expect(envInt('abc', 7)).toBe(7);
    expect(envInt('5368709120', 1)).toBe(5368709120);
  });
});
