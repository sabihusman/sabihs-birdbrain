import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';

/**
 * Client address. The container is reachable only through Nginx on the same
 * host, so the proxy headers are trusted (Nginx must set X-Real-IP or
 * X-Forwarded-For).
 */
export function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip');
  if (real) return real.trim();
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Parse a JSON body against a strict schema; null means "respond 400". */
export async function readJson<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T> | null> {
  const type = c.req.header('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) return null;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(128);
