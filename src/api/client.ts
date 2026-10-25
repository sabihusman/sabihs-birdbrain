import { Emitter } from '../shared/emitter';

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'disabled';
export type UserRole = 'member' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  role: UserRole;
}

export interface AdminUser extends AuthUser {
  emailVerified: boolean;
  createdAt: string;
}

export interface AskAnswer {
  answer: string;
  /** The Wikipedia page (kept for older servers; `sources` lists everything used). */
  source: { title: string; url: string };
  /** Sections the answer cites ("[Wikipedia – Diet]"), with links. Absent from older servers. */
  citations?: Array<{ section: string; url: string; source?: string }>;
  /** Whether the full article sections or only the summary were available. */
  context?: 'article' | 'summary';
  /** True when the server reused an earlier answer to the same question (no model call). */
  cached?: boolean;
  /** Every source the answer drew on: Wikipedia, NatureServe Explorer, eBird (when available). */
  sources?: Array<{ name: string; url: string }>;
  /** The region code the server used. */
  region?: string;
}

/** One UTC day of /v1/ask spend as the admin endpoint reports it (counts only, no questions). */
export interface AskCostDay {
  day: string;
  requests: number;
  promptTokens: number;
  answerTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
  /** Estimated cost in micro-dollars (1,000,000 = $1). */
  costMicros: number;
  unpricedRequests: number;
  cacheHits: number;
}

/** One provider's totals over the admin window: which service answered, how often it was reached by fallback, its tokens. */
export type AskProviderName = 'ollama' | 'gemini' | 'anthropic';

export interface AskProviderTotals {
  provider: AskProviderName;
  requests: number;
  promptTokens: number;
  answerTokens: number;
  fallbacks: number;
}

/** This UTC month's estimated Gemini spend against the hard cap (admin only). */
export interface AskCostMonth {
  month: string;
  spentMicros: number;
  capMicros: number;
  percent: number;
  alertsSent: number[];
}

export interface AskCostSummary {
  model: string;
  days: AskCostDay[];
  month?: AskCostMonth;
  providerOrder?: AskProviderName[];
  models?: Partial<Record<AskProviderName, string | null>>;
  providers?: AskProviderTotals[];
  /** Estimated Claude spend over the window, micro-dollars; null when its model has no listed price (DECISIONS.md #91). */
  estimates?: { anthropic?: number | null };
}

/** What goes to the server with a question (shaped on the device by src/geo/region.ts). */
export interface AskOptions {
  region?: string;
  near?: { lat: number; lon: number };
}

/** A friend as the server lists it: id, display name, since when. */
export interface Friend {
  id: string;
  name: string;
  since: number;
  /** Whether my species list goes to this friend (DECISIONS.md #79); older servers leave it out. */
  sharing?: boolean;
}

/** An invite addressed to me, pending and unexpired; only the inviter's display name travels. */
export interface FriendInvite {
  id: string;
  fromName: string;
  createdAt: number;
  expiresAt: number;
}

/** One species in a shared list: scientific name and the local calendar day it was last spotted. */
export interface SharedSpecies {
  sci: string;
  lastSeen: string;
}

export interface FriendSpecies {
  id: string;
  displayName: string;
  species: SharedSpecies[];
}

interface StoredSession {
  token: string;
  expiresAt: string | null;
  user: AuthUser;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const SESSION_KEY = 'birdbrain.auth.v1';

/** Why the admin account has no delete flow (the server answers `admin_account`). */
export const ADMIN_DELETE_MESSAGE = 'The admin account can’t be deleted from the app, because it approves other members. Ask Sabih.';

/** Human-readable text for API error codes. */
export function describeApiError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error && e.name === 'TypeError' ? 'Could not reach the server. Check your connection.' : 'Something went wrong.';
  switch (e.code) {
    case 'invalid_credentials':
      return 'Email or password is wrong.';
    case 'invalid_code':
      return 'That code is wrong or has expired. Sign in again to get a new one.';
    case 'rate_limited':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'email_unavailable':
      return 'The email with your code could not be sent right now. Try again in a minute.';
    case 'account_disabled':
      return 'This account is disabled.';
    case 'not_approved':
      return 'Your account is awaiting approval.';
    case 'user_cap':
      return 'You have reached today’s question limit.';
    case 'global_cap':
      return 'The daily question limit for everyone has been reached. Try again tomorrow.';
    case 'no_wikipedia_summary':
      return 'There is no Wikipedia summary to answer from for this species.';
    case 'wikipedia_unavailable':
    case 'model_unavailable':
      return 'Bird questions are busy right now. Please try again in a few minutes.';
    case 'unauthorized':
      return 'Please sign in again.';
    case 'payload_too_large':
      return 'That request is too large.';
    case 'invalid_request':
      return 'The server did not accept that. Check what you typed and try again.';
    case 'not_found':
      return 'That invite is no longer open.';
    case 'unknown_species':
      return 'The server did not recognise a species in your list. Update the app and try again.';
    case 'admin_account':
      return ADMIN_DELETE_MESSAGE;
    case 'wrong_password':
      return 'That password is wrong. Your account was not deleted.';
    case 'confirm_mismatch':
      return 'Type DELETE in capitals to confirm. Your account was not deleted.';
    case 'wrong_current_password':
      return 'Your current password is wrong. Nothing was changed.';
    case 'own_account':
      return 'You can’t reset or delete the admin account from this page.';
    case 'no_password_account':
      return 'This account has no password to reset.';
    case 'forbidden':
      return 'Only the admin can do that.';
    case 'invalid_token':
      return 'This link has expired or was already used. Ask for a new one.';
    default:
      return `Request failed (${e.status}).`;
  }
}

export function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof s.token !== 'string' || !s.user || typeof s.user.email !== 'string') return null;
    if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) return null;
    return { token: s.token, expiresAt: s.expiresAt ?? null, user: s.user as AuthUser };
  } catch {
    return null;
  }
}

/** Talks to the Birdbrain API with bearer tokens stored in localStorage. */
export class ApiClient extends Emitter<{ change: AuthUser | null }> {
  private session: StoredSession | null;

  constructor(
    readonly baseUrl: string,
    private storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
    private fetchFn: typeof fetch = (input, init) => fetch(input, init),
  ) {
    super();
    this.session = parseStoredSession(storage?.getItem(SESSION_KEY) ?? null);
  }

  get user(): AuthUser | null {
    return this.session?.user ?? null;
  }

  get signedIn(): boolean {
    return this.session !== null;
  }

  private setSession(s: StoredSession | null): void {
    this.session = s;
    try {
      if (s) this.storage?.setItem(SESSION_KEY, JSON.stringify(s));
      else this.storage?.removeItem(SESSION_KEY);
    } catch {
      /* storage unavailable */
    }
    this.emit('change', s?.user ?? null);
  }

  private async call<T>(path: string, body?: unknown, method: 'GET' | 'POST' = body === undefined ? 'GET' : 'POST'): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.session) headers.Authorization = `Bearer ${this.session.token}`;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      const code = typeof (data as { error?: unknown })?.error === 'string' ? (data as { error: string }).error : 'error';
      if (res.status === 401 && this.session) this.setSession(null);
      throw new ApiError(res.status, code);
    }
    return data as T;
  }

  /**
   * Create an account; like `login`, it answers with a challenge and the code goes by email (DECISIONS.md #77).
   * `invite` and `shareWithInviter` come from an invite link (DECISIONS.md #80).
   */
  signup(email: string, password: string, opts: { name?: string; invite?: string; shareWithInviter?: boolean } = {}): Promise<{ challenge: string; expiresInSeconds: number }> {
    const body: Record<string, unknown> = { email, password };
    if (opts.name) body.name = opts.name;
    if (opts.invite) {
      body.invite = opts.invite;
      body.shareWithInviter = opts.shareWithInviter === true;
    }
    return this.call('/v1/auth/signup', body);
  }

  /** Who sent an invite link; `not_found` for an unknown, used or expired one. */
  inviteInfo(token: string): Promise<{ fromName: string; expiresAt: number }> {
    return this.call('/v1/auth/invite-info', { token });
  }

  login(email: string, password: string): Promise<{ challenge: string; expiresInSeconds: number }> {
    return this.call('/v1/auth/login', { email, password });
  }

  /** "Forgot password?": the same answer for every address (DECISIONS.md #78). */
  forgotPassword(email: string): Promise<{ ok: boolean }> {
    return this.call('/v1/auth/forgot-password', { email });
  }

  /** Set a new password with the token from the emailed link. The server ends every session, this one included. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.call('/v1/auth/reset-password', { token, newPassword });
    this.setSession(null);
  }

  async verify(challenge: string, code: string): Promise<AuthUser> {
    const s = await this.call<StoredSession>('/v1/auth/verify', { challenge, code });
    this.setSession(s);
    return s.user;
  }

  /** Re-validate the stored token; clears it when the server rejects it. */
  async refresh(): Promise<AuthUser | null> {
    if (!this.session) return null;
    try {
      const s = await this.call<StoredSession>('/v1/auth/refresh', {});
      this.setSession(s);
      return s.user;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.setSession(null);
      return this.user;
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.session) await this.call('/v1/auth/logout', {});
    } finally {
      this.setSession(null);
    }
  }

  ask(species: string, question: string, opts: AskOptions = {}): Promise<AskAnswer> {
    const body: Record<string, unknown> = { species, question };
    if (opts.region) body.region = opts.region;
    if (opts.near) body.near = { lat: opts.near.lat, lon: opts.near.lon };
    return this.call('/v1/ask', body);
  }

  /** Set the display name friends see; the cached session is updated so the Account card shows it at once. */
  async setName(name: string): Promise<AuthUser> {
    const res = await this.call<{ ok: boolean; user: AuthUser }>('/v1/me/name', { name });
    if (this.session) this.setSession({ ...this.session, user: res.user });
    return res.user;
  }

  /**
   * Delete the account and everything the server holds for it, immediately and
   * permanently. The password is checked again on the server and `confirm`
   * must be the word DELETE. On success the local session is dropped; on a
   * refusal (wrong password, wrong word, admin account) it stays.
   */
  async deleteAccount(password: string, confirm: string): Promise<void> {
    await this.call('/v1/me/delete', { password, confirm });
    this.setSession(null);
  }

  /**
   * Change my password (the server uses Better Auth's changePassword). Every
   * other session ends; the server hands back a new token for this device,
   * which replaces the cached one.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const s = await this.call<StoredSession>('/v1/me/password', { currentPassword, newPassword });
    this.setSession(s);
  }

  /** Always resolves with "Invite sent" (the server never says whether the address has an account). */
  /** `newAccount`: the address has no account, so a Create account link went out (DECISIONS.md #80). */
  inviteFriend(email: string): Promise<{ ok: boolean; message: string; newAccount?: boolean }> {
    return this.call('/v1/friends/invite', { email });
  }

  listFriends(): Promise<{ friends: Friend[]; invites: FriendInvite[] }> {
    return this.call('/v1/friends');
  }

  respondToInvite(id: string, action: 'accept' | 'decline'): Promise<{ ok: boolean }> {
    return this.call(`/v1/friends/invites/${encodeURIComponent(id)}/${action}`, {});
  }

  /** Share my species list with one friend, or stop; their direction is theirs (DECISIONS.md #79). */
  setFriendSharing(id: string, on: boolean): Promise<{ ok: boolean; sharing: boolean }> {
    return this.call(`/v1/friends/${encodeURIComponent(id)}/share`, { on });
  }

  removeFriend(id: string): Promise<{ ok: boolean }> {
    return this.call(`/v1/friends/${encodeURIComponent(id)}/remove`, {});
  }

  /** Each accepted friend's display name and (scientific name, last-seen day) pairs. */
  friendsSpecies(): Promise<{ friends: FriendSpecies[] }> {
    return this.call('/v1/friends/species');
  }

  /** Replace my shared list with the full current set (scientific name + last-seen day only). */
  uploadSharedSpecies(species: SharedSpecies[]): Promise<{ ok: boolean; count: number }> {
    return this.call('/v1/me/species', { species });
  }

  clearSharedSpecies(): Promise<{ ok: boolean }> {
    return this.call('/v1/me/species/clear', {});
  }

  adminListUsers(): Promise<{ users: AdminUser[] }> {
    return this.call('/v1/admin/users');
  }

  adminSetStatus(id: string, action: 'approve' | 'reject' | 'disable'): Promise<{ ok: boolean; user: AuthUser; emailed?: boolean }> {
    return this.call(`/v1/admin/users/${encodeURIComponent(id)}/${action}`, {});
  }

  /** The server mails the user a reset link (DECISIONS.md #78); nothing changes until they use it. `emailed: false` means the mail failed. */
  adminResetPassword(id: string): Promise<{ ok: boolean; emailed: boolean }> {
    return this.call(`/v1/admin/users/${encodeURIComponent(id)}/reset-password`, {});
  }

  /** Delete the account and everything the server holds for it; `confirm` is the user's email typed again. */
  adminDeleteUser(id: string, confirm: string): Promise<{ ok: boolean; emailed: boolean }> {
    return this.call(`/v1/admin/users/${encodeURIComponent(id)}/delete`, { confirm });
  }

  /** The last 30 days of /v1/ask token and cost totals, newest first. */
  adminAskCosts(): Promise<AskCostSummary> {
    return this.call('/v1/admin/ask-costs');
  }
}
