/**
 * Answer cache for /v1/ask: the same species and the same question (after
 * normalisation) reuse the stored answer for seven days, without a model
 * call and without counting against the daily caps. Only successful answers
 * are stored. The key ignores the member but includes the region and the
 * rounded position: the eBird sections depend on both, so the same question
 * from another state or another place is a different answer.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const ANSWER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Longer questions are cut for the key only; the model still sees the whole question. */
export const MAX_KEY_QUESTION_CHARS = 200;

/** What besides species and question decides the answer. */
export interface AnswerScope {
  /** Region code or "none"; absent counts as "none". */
  region?: string;
  /** Position already rounded to 0.1° by the schema; rounded again here so the key is stable. */
  near?: { lat: number; lon: number };
}

/** Lower-case, trimmed, punctuation removed, whitespace collapsed, capped. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_KEY_QUESTION_CHARS)
    .trim();
}

/** Hash of species + region + rounded position + normalised question, so the table never stores the question. */
export function answerCacheKey(species: string, question: string, scope: AnswerScope = {}): string {
  const near = scope.near ? `${scope.near.lat.toFixed(1)},${scope.near.lon.toFixed(1)}` : '-';
  return createHash('sha256').update(`${species.trim().toLowerCase()}\n${scope.region ?? 'none'}\n${near}\n${normalizeQuestion(question)}`).digest('hex');
}

export interface AnswerCache<T extends object> {
  get(species: string, question: string, scope?: AnswerScope, now?: Date): T | null;
  put(species: string, question: string, scope: AnswerScope, answer: T, now?: Date): void;
}

export function createAnswerCache<T extends object>(db: DatabaseSync, ttlMs = ANSWER_CACHE_TTL_MS): AnswerCache<T> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS answer_cache (
      key TEXT PRIMARY KEY,
      species TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS answer_cache_created ON answer_cache (created_at);
  `);
  const get = db.prepare('SELECT created_at, payload FROM answer_cache WHERE key = ?');
  const put = db.prepare('INSERT INTO answer_cache (key, species, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload');
  const del = db.prepare('DELETE FROM answer_cache WHERE key = ?');
  const prune = db.prepare('DELETE FROM answer_cache WHERE created_at < ?');
  return {
    get(species, question, scope = {}, now = new Date()) {
      const key = answerCacheKey(species, question, scope);
      const row = get.get(key) as { created_at: number; payload: string } | undefined;
      if (!row) return null;
      if (now.getTime() - Number(row.created_at) >= ttlMs) return null;
      try {
        return JSON.parse(row.payload) as T;
      } catch {
        del.run(key);
        return null;
      }
    },
    put(species, question, scope, answer, now = new Date()) {
      prune.run(now.getTime() - ttlMs);
      put.run(answerCacheKey(species, question, scope), species, now.getTime(), JSON.stringify(answer));
    },
  };
}
