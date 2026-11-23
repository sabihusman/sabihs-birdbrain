import type { AuthUser } from '../api/client';
import type { ListenLayout } from './settings';
import type { ModelId } from '../model/v3';

/**
 * Member gating for on-device features (species ID card, sighting history,
 * species clips). Access is decided from the cached session the ApiClient
 * loads from localStorage, so it works offline for approved members; the
 * server is never asked. Signing out clears the cached session (features hide)
 * but never touches IndexedDB (data stays on the device).
 */
export type MemberAccess = 'member' | 'signed-out' | 'pending' | 'blocked';

export function memberAccess(user: AuthUser | null | undefined): MemberAccess {
  if (!user) return 'signed-out';
  if (user.status === 'approved') return 'member';
  if (user.status === 'pending') return 'pending';
  return 'blocked';
}

export function isMember(user: AuthUser | null | undefined): boolean {
  return memberAccess(user) === 'member';
}

/** Short note shown in place of a member feature. */
export function lockedNote(access: Exclude<MemberAccess, 'member'>, feature: string): string {
  switch (access) {
    case 'signed-out':
      return `Sign in to unlock ${feature}.`;
    case 'pending':
      return `${feature} unlocks once your account is approved.`;
    case 'blocked':
      return `Your account cannot use ${feature}.`;
  }
}

/**
 * The admin-only "Manage users" button and page (DECISIONS.md #61): the cached
 * user must be the approved admin. This only decides what the app shows; the
 * server refuses every admin endpoint to anyone else with 403.
 */
export function canManageUsers(user: AuthUser | null | undefined): boolean {
  return !!user && user.role === 'admin' && user.status === 'approved';
}

/** What a non-admin sees on the admin pages. */
export const ADMIN_ONLY_MESSAGE = 'Only the admin can open this page.';

/**
 * The Listen layout actually shown (DECISIONS.md #110): BirdAmp is for approved members, so for anyone else a
 * saved BirdAmp choice shows Focus. The choice itself is kept, so signing back in brings BirdAmp back.
 */
/**
 * The model that actually runs (DECISIONS.md #133): BirdNET+ V3.0 is the admin's test, so it runs only for the
 * approved admin; everyone else gets V2.4 whatever is stored. Like the admin pages, this only decides what this phone
 * does: the V3.0 files on the server are public (Apache 2.0) and nothing secret is behind the check.
 */
export function effectiveModel(choice: ModelId, user: AuthUser | null | undefined): ModelId {
  return choice === 'v3.0' && canManageUsers(user) ? 'v3.0' : 'v2.4';
}

/** Whether Settings shows the model choice at all. */
export const canChooseModel = canManageUsers;

export function effectiveLayout(layout: ListenLayout, user: AuthUser | null | undefined): ListenLayout {
  return layout === 'birdamp' && !isMember(user) ? 'focus' : layout;
}
