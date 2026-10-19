import type { Generator } from './ask.js';
import type { AskCostStore, CapAlertLevel } from './ask-cost.js';
import { formatUsd } from './pricing.js';
import { ProviderError } from './providers/ollama.js';

/**
 * Hard monthly Gemini spend cap (DECISIONS.md #53). Wraps the Gemini generator:
 * before a call, the month's estimated spend (every Gemini call is priced by
 * `AskCostStore.record`, unknown models at the most expensive known price) is
 * compared with the cap; at or over it the call is skipped with a
 * `ProviderError('cap')`, so the chain falls back to Ollama or, when nothing
 * is left, to the generic "busy" answer. After each call the 50 % and 100 %
 * thresholds are checked and the admin is mailed once per level per UTC
 * month. The cap is read from GEMINI_MONTHLY_CAP_USD; 0 means Gemini is never
 * called. Nothing here is on the public /health endpoint.
 */
export interface CapGuardOptions {
  costs: AskCostStore;
  /** USD; converted to micro-dollars. */
  capUsd: number;
  /** Sends the alert mail; failures are logged, never thrown into a member's request. */
  sendAlert?: (level: CapAlertLevel, status: { month: string; spentMicros: number; capMicros: number }) => Promise<void>;
  log?: (line: string) => void;
  now?: () => Date;
}

export const CAP_ALERT_LEVELS: readonly CapAlertLevel[] = [50, 100];

export function capMicrosOf(capUsd: number): number {
  return Math.round(capUsd * 1_000_000);
}

export function createGeminiCapGuard(generate: Generator, opts: CapGuardOptions): Generator {
  const log = opts.log ?? ((line: string) => console.info(line));
  const now = opts.now ?? (() => new Date());
  const capMicros = capMicrosOf(opts.capUsd);
  const checkAlerts = async (): Promise<void> => {
    if (capMicros <= 0) return;
    const at = now();
    const spent = opts.costs.monthSpendMicros(at);
    for (const level of CAP_ALERT_LEVELS) {
      if (spent * 100 < capMicros * level) continue;
      if (!opts.costs.markAlert(level, at)) continue; // already sent this month
      const status = { month: at.toISOString().slice(0, 7), spentMicros: spent, capMicros };
      log(`[cap] gemini month=${status.month} spent_usd=${formatUsd(spent)} cap_usd=${formatUsd(capMicros)} alert=${level}%`);
      try {
        await opts.sendAlert?.(level, status);
      } catch (err) {
        log(`[cap] alert mail failed: ${err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'}`);
      }
    }
  };
  return async (input) => {
    const at = now();
    const spent = opts.costs.monthSpendMicros(at);
    if (spent >= capMicros) {
      log(`[cap] gemini skipped month=${at.toISOString().slice(0, 7)} spent_usd=${formatUsd(spent)} cap_usd=${formatUsd(capMicros)}`);
      throw new ProviderError('cap');
    }
    const answer = await generate(input);
    await checkAlerts();
    return answer;
  };
}

/** Subject and body of the admin alert; counts and amounts only, no questions. */
export function capAlertMail(level: CapAlertLevel, status: { month: string; spentMicros: number; capMicros: number }): { subject: string; body: string } {
  const spent = `$${(status.spentMicros / 1_000_000).toFixed(2)}`;
  const cap = `$${(status.capMicros / 1_000_000).toFixed(2)}`;
  if (level >= 100) {
    return {
      subject: `Gemini cap reached for ${status.month}: ${spent} of ${cap}`,
      body: `The estimated Gemini spend for ${status.month} is ${spent}, at or over the ${cap} monthly cap (GEMINI_MONTHLY_CAP_USD).\n\nGemini is now skipped for the rest of the month; bird questions are answered by Ollama only. If Ollama is also unavailable, members see "Bird questions are busy right now. Please try again in a few minutes."\n\nTo raise the cap, change GEMINI_MONTHLY_CAP_USD in /opt/birdbrain/.env and recreate the container. Spend per day is in the admin view.`,
    };
  }
  return {
    subject: `Gemini spend at ${level}% for ${status.month}: ${spent} of ${cap}`,
    body: `The estimated Gemini spend for ${status.month} has reached ${spent}, ${level}% of the ${cap} monthly cap (GEMINI_MONTHLY_CAP_USD).\n\nGemini keeps answering until the cap; after that it is skipped for the rest of the month and Ollama answers alone. Spend per day is in the admin view.`,
  };
}
