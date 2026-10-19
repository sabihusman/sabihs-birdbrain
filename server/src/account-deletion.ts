import type { DatabaseSync } from 'node:sqlite';

/**
 * Delete an account and every row keyed to it, in one `BEGIN IMMEDIATE`
 * transaction. Immediate and permanent: no grace period, no undo.
 *
 * What the server holds for a person (searched in `db.ts`, `auth.ts` and the
 * source caches): the Better Auth `user`, `account` (password hash) and
 * `session` rows and anything in `verification` for the address; the app's
 * `login_challenge` (emailed codes), `ask_usage` counter under `user:<id>`,
 * `shared_species`, `friendship` in both directions, `friend_invite` in both
 * directions and `invite_usage`. Sightings, clips, detections and ticks live
 * only on the device (IndexedDB) and never reach the server; the
 * `wiki_article_cache`, `natureserve_cache` and `ebird_cache` tables hold
 * public species text keyed by scientific name, not by person. Questions and
 * answers are not stored. There are no per-user files on disk.
 */
export function deleteUserCompletely(db: DatabaseSync, userId: string, email: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM shared_species WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM friendship WHERE user_a = ? OR user_b = ?').run(userId, userId);
    db.prepare('DELETE FROM friend_invite WHERE from_user_id = ? OR to_user_id = ?').run(userId, userId);
    db.prepare('DELETE FROM invite_usage WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM ask_usage WHERE scope = ?').run(`user:${userId}`);
    db.prepare('DELETE FROM login_challenge WHERE user_id = ? OR lower(email) = lower(?)').run(userId, email);
    db.prepare('DELETE FROM verification WHERE lower(identifier) = lower(?) OR value = ?').run(email, userId);
    db.prepare('DELETE FROM session WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM account WHERE userId = ?').run(userId);
    db.prepare('DELETE FROM user WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The mail sent after the commit; short, and it names nothing but the app. */
export function deletionMail(to: string): { to: string; subject: string; text: string } {
  return {
    to,
    subject: 'Your Birdbrain account was deleted',
    text: 'Your Sabih’s Birdbrain account and everything stored with it on the server (sign-in details, sessions, friends, invites and your shared species list) were deleted just now, permanently. Copies in server backups are removed when those backups expire. Sightings and recordings saved on your phone are not affected unless you chose to clear them.\n\nIf you did not do this, reply to this message.',
  };
}
