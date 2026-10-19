/**
 * Answer cache for /v1/ask: the same species and the same question (after
 * normalisation) reuse the stored answer for seven days, without a model
 * call and without counting against the daily caps. Only successful answers
 * are stored. The key ignores the member and their region: the context is
 * the Wikipedia article, which is the same for everyone.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const ANSWER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Longer questions are cut for the key only; the model still sees the whole question. */
export const MAX_KEY_QUESTION_CHARS = 200;

export interface CachedAnswer {
  answer: string;
  source: { title: string; url: string };
  citations: Array<{ section: string; url: string }>;
  context: 'article' | 'summary';
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

/** Hash of species + normalised question, so the table never stores the question. */
export function answerCacheKey(species: string, question: string): string {
  return createHash('sha256').update(`${species.trim().toLowerCase()}\n${normalizeQuestion(question)}`).digest('hex');
}

export interface AnswerCache {
  get(species: string, question: string, now?: Date): CachedAnswer | null;
  put(species: string, question: string, answer: CachedAnswer, now?: Date): void;
}

export function createAnswerCache(db: DatabaseSync, ttlMs = ANSWER_CACHE_TTL_MS): AnswerCache {
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
    get(species, question, now = new Date()) {
      const row = get.get(answerCacheKey(species, question)) as { created_at: number; payload: string } | undefined;
      if (!row) return null;
      if (now.getTime() - Number(row.created_at) >= ttlMs) return null;
      try {
        return JSON.parse(row.payload) as CachedAnswer;
      } catch {
        del.run(answerCacheKey(species, question));
        return null;
      }
    },
    put(species, question, answer, now = new Date()) {
      prune.run(now.getTime() - ttlMs);
      put.run(answerCacheKey(species, question), species, now.getTime(), JSON.stringify(answer));
    },
  };
}
