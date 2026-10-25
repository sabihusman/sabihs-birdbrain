import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { INVITE_TTL_DAYS, type FriendsStore } from './friends.js';
import type { Mail } from './mailer.js';

/**
 * Invites to an address with no account (DECISIONS.md #80). The mail carries a link to Create
 * account with a one-use token; creating the account (after its code) claims the invite, and
 * Sabih's approval turns it into a friendship. Neither the token nor the address is stored in
 * the clear: the row keeps SHA-256 of the token and an HMAC of the address (to avoid mailing
 * the same person twice), so a copy of the database names no one who never joined.
 */
export interface InviteInfo {
  fromName: string;
  expiresAt: number;
}

export interface JoinedFriend {
  inviterId: string;
  inviterName: string;
  inviterEmail: string;
}

export class EmailInvites {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secret: string,
  ) {}

  emailHash(email: string): string {
    return createHmac('sha256', this.secret).update(email.trim().toLowerCase()).digest('hex');
  }

  private tokenId(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Unexpired, unclaimed invites only; claimed ones wait for approval whatever their age. */
  purgeExpired(now = Date.now()): void {
    this.db.prepare('DELETE FROM email_invite WHERE expires_at <= ? AND claimed_by IS NULL').run(now);
  }

  /** An open invite from this member to this address already exists. */
  openFor(fromUserId: string, email: string, now = Date.now()): boolean {
    return this.db.prepare('SELECT 1 FROM email_invite WHERE from_user_id = ? AND email_hash = ? AND expires_at > ? AND claimed_by IS NULL').get(fromUserId, this.emailHash(email), now) !== undefined;
  }

  /** Store a new invite and return the token for the link (never stored). */
  create(fromUserId: string, email: string, now = Date.now()): string {
    const token = randomBytes(24).toString('base64url');
    this.db
      .prepare('INSERT INTO email_invite (id, from_user_id, email_hash, created_at, expires_at, claimed_by, share_back) VALUES (?, ?, ?, ?, ?, NULL, 0)')
      .run(this.tokenId(token), fromUserId, this.emailHash(email), now, now + INVITE_TTL_DAYS * 86_400_000);
    return token;
  }

  /** The inviter's display name for the Create account page; null for an unknown, used or expired token. */
  info(token: string, now = Date.now()): InviteInfo | null {
    const row = this.db
      .prepare("SELECT u.name AS fromName, i.expires_at FROM email_invite i JOIN user u ON u.id = i.from_user_id WHERE i.id = ? AND i.expires_at > ? AND i.claimed_by IS NULL AND u.status = 'approved'")
      .get(this.tokenId(token), now) as { fromName: string; expires_at: number } | undefined;
    return row ? { fromName: String(row.fromName ?? ''), expiresAt: Number(row.expires_at) } : null;
  }

  /** Tie the invite to the new account, with its answer to "share back". False when there is nothing to claim. */
  claim(token: string, userId: string, shareBack: boolean, now = Date.now()): boolean {
    return (
      this.db
        .prepare('UPDATE email_invite SET claimed_by = ?, share_back = ? WHERE id = ? AND expires_at > ? AND claimed_by IS NULL AND from_user_id <> ?')
        .run(userId, shareBack ? 1 : 0, this.tokenId(token), now, userId).changes > 0
    );
  }

  /**
   * Once the account is approved: each claimed invite from a still-approved member becomes a
   * friendship. The inviter's list goes to the new member (sending the invite was the inviter's
   * yes); the new member's list goes back only if they ticked the box. The rows are then gone.
   */
  applyClaimed(userId: string, friends: FriendsStore, now = Date.now()): JoinedFriend[] {
    const rows = this.db
      .prepare("SELECT i.id, i.from_user_id, i.share_back, u.name, u.email FROM email_invite i JOIN user u ON u.id = i.from_user_id WHERE i.claimed_by = ? AND u.status = 'approved'")
      .all(userId) as Array<{ id: string; from_user_id: string; share_back: number; name: string; email: string }>;
    const joined: JoinedFriend[] = [];
    for (const r of rows) {
      if (!friends.areFriends(r.from_user_id, userId)) {
        friends.befriend(r.from_user_id, userId, { firstShares: true, secondShares: Number(r.share_back) === 1 }, now);
        joined.push({ inviterId: r.from_user_id, inviterName: String(r.name ?? ''), inviterEmail: String(r.email) });
      }
      this.db.prepare('DELETE FROM email_invite WHERE id = ?').run(r.id);
    }
    return joined;
  }
}

/** The invite mail to someone without an account. The inviter is named by display name only. */
export function joinInviteMail(to: string, fromName: string, link: string): Mail {
  return {
    to,
    subject: 'An invite to Sabih’s Birdbrain',
    text: `${fromName} invited you to Sabih’s Birdbrain, an app that recognises birds by their song, on your phone.\n\nCreate your account with this link:\n${link}\n\nSabih approves each new account by hand. Once yours is approved, you and ${fromName} become friends: you see which birds they have spotted and the day they last spotted each one, and nothing else. When you create the account you choose whether they see yours too.\n\nThe invite expires in ${INVITE_TTL_DAYS} days. If you do not know this person, ignore this message.`,
  };
}

/** To the inviter, once the person they invited is approved. */
export function friendJoinedMail(to: string, name: string, appUrl: string): Mail {
  return {
    to,
    subject: 'Your friend joined Birdbrain',
    text: `${name} accepted your invite and Sabih approved their account, so you are now friends on Sabih’s Birdbrain.\n\nManage what you share with each friend on My account: ${appUrl}/#/account`,
  };
}
