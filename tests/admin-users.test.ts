import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, describeApiError, SESSION_KEY, type AuthUser } from '../src/api/client';
import { ADMIN_ONLY_MESSAGE, canManageUsers } from '../src/app/access';
import { hrefFor, parseHash } from '../src/ui/router';
import { confirmText, deleteConfirmed, resultText, userActions } from '../src/ui/views/admin';
import { MemoryStorage } from './helpers/memory-storage';

const user = (over: Partial<AuthUser>): AuthUser => ({ id: 'u1', email: 'sam@example.com', name: 'Sam', status: 'approved', role: 'member', ...over });

describe('Manage users button (admin only)', () => {
  it('shows only for the approved admin', () => {
    expect(canManageUsers(user({ role: 'admin', status: 'approved' }))).toBe(true);
    expect(canManageUsers(user({ role: 'admin', status: 'pending' }))).toBe(false);
    expect(canManageUsers(user({ role: 'admin', status: 'disabled' }))).toBe(false);
    expect(canManageUsers(user({ role: 'member', status: 'approved' }))).toBe(false);
    expect(canManageUsers(user({ role: 'member', status: 'pending' }))).toBe(false);
    expect(canManageUsers(null)).toBe(false);
    expect(canManageUsers(undefined)).toBe(false);
    expect(ADMIN_ONLY_MESSAGE).toBe('Only the admin can open this page.');
  });

  it('routes #/admin/users to the user management page and keeps #/admin for costs', () => {
    expect(parseHash('#/admin/users')).toEqual({ name: 'admin-users' });
    expect(parseHash('#/admin')).toEqual({ name: 'admin' });
    expect(hrefFor({ name: 'admin-users' })).toBe('#/admin/users');
    expect(hrefFor({ name: 'admin' })).toBe('#/admin');
  });
});

describe('user management rows', () => {
  it('offers the right buttons per status, and none on the admin account', () => {
    expect(userActions({ status: 'pending', role: 'member' }, false)).toEqual(['approve', 'reject', 'reset', 'delete']);
    expect(userActions({ status: 'approved', role: 'member' }, false)).toEqual(['disable', 'reset', 'delete']);
    expect(userActions({ status: 'disabled', role: 'member' }, false)).toEqual(['approve', 'reset', 'delete']);
    expect(userActions({ status: 'rejected', role: 'member' }, false)).toEqual(['approve', 'reset', 'delete']);
    expect(userActions({ status: 'approved', role: 'admin' }, true)).toEqual([]);
    expect(userActions({ status: 'approved', role: 'admin' }, false)).toEqual([]);
  });

  it('asks first and reports in plain words, including a failed reset mail', () => {
    expect(confirmText('reset', 'sam@example.com')).toMatch(/temporary password.*not see the password/);
    expect(confirmText('delete', 'sam@example.com')).toMatch(/no undo.*Type their email/);
    expect(resultText('reset', 'sam@example.com', true)).toMatch(/^Password reset\. sam@example.com was emailed/);
    expect(resultText('reset', 'sam@example.com', false)).toBe('Password reset, but the email could not be sent. Try again.');
    expect(resultText('delete', 'sam@example.com', true)).toMatch(/was deleted/);
  });

  it('enables Delete only when the typed address matches', () => {
    expect(deleteConfirmed('', 'sam@example.com')).toBe(false);
    expect(deleteConfirmed('sam@example', 'sam@example.com')).toBe(false);
    expect(deleteConfirmed('alex@example.com', 'sam@example.com')).toBe(false);
    expect(deleteConfirmed('  Sam@Example.com ', 'sam@example.com')).toBe(true);
  });

  it('explains the new error codes', () => {
    expect(describeApiError(new ApiError(400, 'own_account'))).toMatch(/admin account/);
    expect(describeApiError(new ApiError(400, 'wrong_current_password'))).toMatch(/current password is wrong/);
    expect(describeApiError(new ApiError(403, 'forbidden'))).toBe('Only the admin can do that.');
  });
});

describe('API client', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('posts reset and delete to the admin endpoints with the bearer token', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 'tok', expiresAt: null, user: user({ role: 'admin' }) }));
    const calls: Array<{ url: string; body: unknown; auth: string | undefined }> = [];
    const api = new ApiClient('https://api.test', storage, async (input, init) => {
      calls.push({ url: `${init?.method} ${String(input)}`, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as Record<string, string>).Authorization });
      return ok({ ok: true, emailed: false });
    });
    expect(await api.adminResetPassword('u/2')).toEqual({ ok: true, emailed: false });
    await api.adminDeleteUser('u2', 'sam@example.com');
    expect(calls).toEqual([
      { url: 'POST https://api.test/v1/admin/users/u%2F2/reset-password', body: {}, auth: 'Bearer tok' },
      { url: 'POST https://api.test/v1/admin/users/u2/delete', body: { confirm: 'sam@example.com' }, auth: 'Bearer tok' },
    ]);
  });

  it('changing my password replaces the cached token', async () => {
    const storage = new MemoryStorage();
    storage.setItem(SESSION_KEY, JSON.stringify({ token: 'old', expiresAt: null, user: user({}) }));
    const api = new ApiClient('https://api.test', storage, async () => ok({ token: 'new', expiresAt: null, user: user({}) }));
    await api.changePassword('old-password', 'new-password');
    expect(JSON.parse(storage.getItem(SESSION_KEY) ?? '{}').token).toBe('new');
    expect(storage.getItem(SESSION_KEY)).not.toContain('new-password');
  });
});
