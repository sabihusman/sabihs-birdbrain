import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';

export type UserStatus = 'pending' | 'approved' | 'rejected' | 'disabled';
export type UserRole = 'member' | 'admin';

/** The user shape returned by Better Auth plus our additional fields. */
export interface AppUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  status: UserStatus;
  role: UserRole;
  createdAt: Date;
}

/**
 * Better Auth handles passwords, users and sessions. The HTTP handler is not
 * mounted; the app calls auth.api server-side so it can add the email code
 * step and keep every response generic.
 */
export function authOptions(db: DatabaseSync, config: Config) {
  return {
    database: db,
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    basePath: '/v1/auth/internal',
    trustedOrigins: config.allowedOrigins,
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      // A password reset by emailed link signs the account out everywhere (DECISIONS.md #78).
      revokeSessionsOnPasswordReset: true,
    },
    // Reset tokens are stored as SHA-256 hashes, so a copy of the database cannot reset passwords.
    verification: { storeIdentifier: { default: 'plain', overrides: { 'reset-password:': 'hashed' } } },
    session: {
      expiresIn: config.SESSION_TTL_SECONDS,
      updateAge: config.SESSION_UPDATE_AGE_SECONDS,
    },
    user: {
      additionalFields: {
        status: { type: 'string', required: false, defaultValue: 'pending', input: false },
        role: { type: 'string', required: false, defaultValue: 'member', input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const isAdmin = user.email.toLowerCase() === config.adminEmail;
            return { data: { ...user, status: isAdmin ? 'approved' : 'pending', role: isAdmin ? 'admin' : 'member' } };
          },
        },
      },
    },
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    plugins: [bearer()],
  } satisfies BetterAuthOptions;
}

/** Create Better Auth's tables/columns. Must run before createAuth so the instance's schema check passes. */
export async function migrateAuth(db: DatabaseSync, config: Config): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions(db, config));
  await runMigrations();
}

export function createAuth(db: DatabaseSync, config: Config) {
  return betterAuth(authOptions(db, config));
}

export type Auth = ReturnType<typeof createAuth>;

export function toAppUser(u: Record<string, unknown>): AppUser {
  return {
    id: String(u.id),
    email: String(u.email),
    name: String(u.name ?? ''),
    emailVerified: Boolean(u.emailVerified),
    status: (typeof u.status === 'string' ? u.status : 'pending') as UserStatus,
    role: (typeof u.role === 'string' ? u.role : 'member') as UserRole,
    createdAt: u.createdAt instanceof Date ? u.createdAt : new Date(String(u.createdAt)),
  };
}

export function publicUser(u: AppUser) {
  return { id: u.id, email: u.email, name: u.name, status: u.status, role: u.role };
}
