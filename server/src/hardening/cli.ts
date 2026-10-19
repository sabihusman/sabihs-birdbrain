/**
 * CLI for the hardening run. In the API container (recommended, it has the
 * server's .env):
 *
 *   docker compose -f /opt/birdbrain/compose.yml run --rm --no-deps -T \
 *     -v /opt/birdbrain/hardening:/reports api node dist/hardening/cli.js --out /reports [--provider chain|ollama|gemini] [--budget 0.05] [--only H01,H03] [--dry-run]
 *
 * Locally: `cd server && npm run harden -- --dry-run` (needs a built dist and the env variables).
 * Exit codes: 0 all passed, 1 a case failed, 2 bad usage, 3 run stopped for budget with failures or no cases run.
 */
import { loadConfig } from '../config.js';
import { runHardening, type ProviderChoice } from './runner.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Reports go next to the working directory by default (never a world-writable temp folder); the container invocation passes --out /reports. */
const DEFAULT_OUT_DIR = 'hardening-reports';

async function main(): Promise<number> {
  const provider = (arg('--provider') ?? 'chain') as ProviderChoice;
  if (!['chain', 'ollama', 'gemini'].includes(provider)) {
    console.error('--provider must be chain, ollama or gemini');
    return 2;
  }
  const budgetUsd = Number(arg('--budget') ?? '0.05');
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    console.error('--budget must be a non-negative number of USD');
    return 2;
  }
  const only = arg('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = arg('--out') ?? process.env.HARDEN_OUT_DIR ?? DEFAULT_OUT_DIR;
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const report = await runHardening(config, { provider, budgetUsd, only, outDir, dryRun });
  if (dryRun) return 0;
  if (report.cases.length === 0) return 3;
  if (report.failed > 0) return report.stoppedForBudget ? 3 : 1;
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`[harden] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
