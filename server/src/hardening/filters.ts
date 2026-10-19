/**
 * Output filter for /v1/ask answers (DECISIONS.md #54, OWASP LLM02/LLM07):
 * defence in depth after `toPlainText` (which already strips tags and control
 * characters and caps the length). Every provider's reply passes through here
 * before a member sees it. The filter never sees or logs the question.
 *
 * - system-prompt echo: rejected (the existing `leaksSystemPrompt` rule);
 * - env-like strings and secret-shaped tokens: redacted;
 * - coordinates (decimal degree pairs): redacted, members' positions are
 *   never meant to come back in prose (the app shows location itself);
 * - HTML or script: already stripped by `toPlainText`; flagged here when the
 *   raw text carried any, so the hardening run can see the model did it;
 * - runaway output: flagged when the raw text exceeded the answer cap.
 */
import { leaksSystemPrompt, MAX_ANSWER_CHARS } from '../ask.js';

export type OutputFlag = 'system_prompt' | 'secret' | 'coordinates' | 'markup' | 'runaway';

export interface FilteredAnswer {
  /** The text to return; empty when the answer must be rejected. */
  text: string;
  flags: OutputFlag[];
  /** True when the answer is refused outright (system prompt echo). */
  rejected: boolean;
}

/** `NAME=value` with a secret-looking name, or the shapes of common API keys and bearer tokens. */
const ENV_LIKE = /\b[A-Z][A-Z0-9_]{2,}(?:_)?(?:KEY|SECRET|TOKEN|PASSWORD|PASS|APIKEY)\b\s*[=:]\s*\S+/g;
const SECRET_SHAPES = [/\bAIza[0-9A-Za-z_-]{30,}\b/g, /\bsk-[0-9A-Za-z_-]{16,}\b/g, /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g, /\bBearer\s+[0-9A-Za-z._-]{16,}\b/g, /\b[0-9a-f]{64}\b/g];
/** Two decimal numbers with at least two decimals, separated by a comma or "and", both in coordinate range. */
const COORDINATES = /(-?\d{1,3}\.\d{2,})\s*(?:,|and|;)\s*(-?\d{1,3}\.\d{2,})/g;
const MARKUP = /<[a-z!/][^>]*>|\]\(https?:\/\/|javascript:/i;

export const COORDINATE_REDACTION = '[location removed]';
export const SECRET_REDACTION = '[removed]';

function inRange(lat: string, lon: string): boolean {
  const a = Number(lat);
  const b = Number(lon);
  return Math.abs(a) <= 90 && Math.abs(b) <= 180;
}

/** Redact decimal coordinate pairs; plain numbers (counts, dates, percentages) are left alone. */
export function redactCoordinates(text: string): { text: string; hit: boolean } {
  let hit = false;
  const out = text.replace(COORDINATES, (m, lat: string, lon: string) => {
    if (!inRange(lat, lon)) return m;
    hit = true;
    return COORDINATE_REDACTION;
  });
  return { text: out, hit };
}

/** Redact env-like assignments and secret-shaped tokens. */
export function redactSecrets(text: string): { text: string; hit: boolean } {
  let hit = false;
  let out = text.replace(ENV_LIKE, () => {
    hit = true;
    return SECRET_REDACTION;
  });
  for (const re of SECRET_SHAPES) {
    out = out.replace(re, () => {
      hit = true;
      return SECRET_REDACTION;
    });
  }
  return { text: out, hit };
}

/**
 * Apply the filter. `raw` is the provider's text before `toPlainText`;
 * `plain` is the result of `toPlainText(raw)` (what would have been returned).
 */
export function filterAnswer(raw: string, plain: string): FilteredAnswer {
  const flags: OutputFlag[] = [];
  if (MARKUP.test(raw)) flags.push('markup');
  if (raw.length > MAX_ANSWER_CHARS) flags.push('runaway');
  if (leaksSystemPrompt(plain)) {
    flags.push('system_prompt');
    return { text: '', flags, rejected: true };
  }
  let text = plain;
  const s = redactSecrets(text);
  if (s.hit) flags.push('secret');
  text = s.text;
  const c = redactCoordinates(text);
  if (c.hit) flags.push('coordinates');
  text = c.text;
  return { text: text.trim(), flags, rejected: false };
}
