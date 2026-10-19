import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8010),
  DATABASE_PATH: z.string().default('/data/birdbrain.db'),
  LABELS_PATH: z.string().default('./data/labels.json'),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().min(1),
  ADMIN_EMAIL: z.string().email(),
  MAIL_TRANSPORT: z.enum(['smtp', 'console']).default('smtp'),
  SMTP_USER: z.string().optional(),
  SMTP_APP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  // Provider chain for /v1/ask (DECISIONS.md #49): tried in this order, each one falling back to the next.
  AI_PROVIDER_ORDER: z.string().default('ollama,gemini'),
  OLLAMA_API_KEY: z.string().optional(),
  OLLAMA_MODEL: z.string().default('gemma4:31b'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(8000),
  /** eBird API 2.0 key (optional): without it /v1/ask answers without eBird sightings. Never logged. */
  EBIRD_API_KEY: z.string().trim().min(1).optional(),
  ASK_DAILY_PER_USER: z.coerce.number().int().min(0).default(20),
  ASK_DAILY_GLOBAL: z.coerce.number().int().min(0).default(200),
  ASK_MAX_QUESTION_CHARS: z.coerce.number().int().min(1).max(500).default(500),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(24 * 60 * 60),
  SESSION_UPDATE_AGE_SECONDS: z.coerce.number().int().min(60).default(60 * 60),
  LOGIN_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(10 * 60),
  BACKUP_DIR: z.string().default('/backups'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
});

export type Env = z.infer<typeof envSchema>;

export const PROVIDER_NAMES = ['ollama', 'gemini'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface Config extends Env {
  allowedOrigins: string[];
  adminEmail: string;
  /** `AI_PROVIDER_ORDER` parsed: unique, known names, in order. */
  providerOrder: ProviderName[];
}

/** Parse "ollama, gemini" into known provider names; unknown or repeated names are a configuration error. */
export function parseProviderOrder(raw: string): ProviderName[] {
  const names = raw
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) throw new Error('Invalid configuration: AI_PROVIDER_ORDER is empty');
  const out: ProviderName[] = [];
  for (const n of names) {
    if (!(PROVIDER_NAMES as readonly string[]).includes(n)) throw new Error(`Invalid configuration: AI_PROVIDER_ORDER has an unknown provider: ${n}`);
    if (out.includes(n as ProviderName)) throw new Error(`Invalid configuration: AI_PROVIDER_ORDER repeats ${n}`);
    out.push(n as ProviderName);
  }
  return out;
}

/** Parse and validate process.env (or a test override). Never logs values. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${names}`);
  }
  const env = parsed.data;
  if (env.MAIL_TRANSPORT === 'smtp' && (!env.SMTP_USER || !env.SMTP_APP_PASSWORD)) {
    throw new Error('Invalid configuration: SMTP_USER and SMTP_APP_PASSWORD are required when MAIL_TRANSPORT=smtp');
  }
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const o of allowedOrigins) {
    if (!/^https?:\/\/[^/]+$/.test(o)) throw new Error(`Invalid configuration: ALLOWED_ORIGINS entry is not an origin: ${o}`);
  }
  // The Vite dev server, only outside production (compose.yml pins NODE_ENV=production).
  const DEV_ORIGIN = 'http://localhost:5173';
  if (env.NODE_ENV !== 'production' && !allowedOrigins.includes(DEV_ORIGIN)) allowedOrigins.push(DEV_ORIGIN);
  return { ...env, allowedOrigins, adminEmail: env.ADMIN_EMAIL.toLowerCase(), providerOrder: parseProviderOrder(env.AI_PROVIDER_ORDER) };
}

/** Every variable the server reads, for documentation and the .env template. */
export const ENV_VARIABLE_NAMES = Object.keys(envSchema.shape) as Array<keyof Env>;
