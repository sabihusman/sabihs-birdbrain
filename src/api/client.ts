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
  source: { title: string; url: string };
  /** Wikipedia sections the answer cites ("[Diet]"), with section links. Absent from older servers. */
  citations?: Array<{ section: string; url: string }>;
  /** Whether the full article sections or only the summary were available. */
  context?: 'article' | 'summary';
}

/** A friend as the server lists it: id, display name, since when. */
export interface Friend {
  id: string;
  name: string;
  since: number;
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
      return 'The sign-in email could not be sent right now. Try again in a minute.';
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
      return 'The answer service is unavailable right now.';
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
      return 'The admin account cannot be deleted from the app.';
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

  signup(email: string, password: string): Promise<{ ok: boolean; message: string }> {
    return this.call('/v1/auth/signup', { email, password });
  }

  login(email: string, password: string): Promise<{ challenge: string; expiresInSeconds: number }> {
    return this.call('/v1/auth/login', { email, password });
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

  ask(species: string, question: string): Promise<AskAnswer> {
    return this.call('/v1/ask', { species, question });
  }

  /** Set the display name friends see; the cached session is updated so the Account card shows it at once. */
  async setName(name: string): Promise<AuthUser> {
    const res = await this.call<{ ok: boolean; user: AuthUser }>('/v1/me/name', { name });
    if (this.session) this.setSession({ ...this.session, user: res.user });
    return res.user;
  }

  /** Delete the account and everything the server holds for it; the local session is dropped either way. */
  async deleteAccount(): Promise<void> {
    try {
      await this.call('/v1/me/delete', {});
    } finally {
      this.setSession(null);
    }
  }

  /** Always resolves with "Invite sent" (the server never says whether the address has an account). */
  inviteFriend(email: string): Promise<{ ok: boolean; message: string }> {
    return this.call('/v1/friends/invite', { email });
  }

  listFriends(): Promise<{ friends: Friend[]; invites: FriendInvite[] }> {
    return this.call('/v1/friends');
  }

  respondToInvite(id: string, action: 'accept' | 'decline'): Promise<{ ok: boolean }> {
    return this.call(`/v1/friends/invites/${encodeURIComponent(id)}/${action}`, {});
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

  adminSetStatus(id: string, action: 'approve' | 'reject' | 'disable'): Promise<{ ok: boolean; user: AuthUser }> {
    return this.call(`/v1/admin/users/${encodeURIComponent(id)}/${action}`, {});
  }
}
