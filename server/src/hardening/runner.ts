/**
 * `npm run harden`: run the hardening cases against the real provider chain
 * from inside the API container (DECISIONS.md #54).
 *
 * - Reads the server's configuration (`/opt/birdbrain/.env` via compose), so
 *   the same keys, models and cap apply as in production.
 * - Uses an in-memory SQLite database for usage counters, source caches and
 *   the answer cache: the live database is never opened.
 * - Fetches the real Wikipedia, NatureServe and eBird text, then appends the
 *   case's injected text to it, exactly where an attacker could place it.
 * - Captures each provider's raw reply before the server's output rules, so
 *   the report shows both what the member got and what the model did.
 * - Estimates Gemini spend with the price table and stops before a case
 *   would exceed `--budget` (the run also counts toward the monthly cap).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerQuestion, type AnswerModel, type AskDeps } from '../ask.js';
import { createAskCostStore } from '../ask-cost.js';
import type { Config } from '../config.js';
import { createUsageStore, openDatabase } from '../db.js';
import { createEbirdApi, createEbirdSource, type EbirdApi, type EbirdSource } from '../ebird.js';
import { loadLabels, type SpeciesLabels } from '../labels.js';
import { createNatureServeCache, fetchNatureServeStatus, type NatureServeFetcher } from '../natureserve.js';
import { createProviderChain } from '../providers/index.js';
import { fetchWikipediaSummary } from '../wiki.js';
import { createArticleCache, fetchWikipediaArticle, type ArticleFetcher } from '../wiki-article.js';
import { HARDENING_CASES, judgeCase, type CaseResult, type HardeningCase } from './cases.js';
import { filterAnswer, type OutputFlag } from './filters.js';
import { toPlainText } from '../ask.js';

export type ProviderChoice = 'chain' | 'ollama' | 'gemini';

export interface RunOptions {
  provider: ProviderChoice;
  /** USD; the run stops before a case that could push the estimated Gemini spend over it. */
  budgetUsd: number;
  /** Case IDs to run (default all). */
  only?: string[];
  /** Report folder; the file is harden-<timestamp>-<provider>.json. */
  outDir: string;
  dryRun: boolean;
  log?: (line: string) => void;
  now?: () => Date;
  /** Test hook: labels without reading LABELS_PATH. */
  labels?: SpeciesLabels;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  provider: ProviderChoice;
  models: { ollama: string; gemini: string };
  cases: CaseResult[];
  passed: number;
  failed: number;
  /** Estimated Gemini spend of this run, USD. */
  geminiSpendUsd: number;
  stoppedForBudget: boolean;
  reportFile?: string;
}

/** Per-case estimate used for the budget stop: a Flash-Lite call with the lean context is well under this. */
export const PER_CASE_GEMINI_ESTIMATE_USD = 0.01;

/** Live sources wrapped so that one case's injected text is appended, and nothing is cached across cases. */
function injectingSources(config: Config, db: ReturnType<typeof openDatabase>, current: () => HardeningCase | null): Pick<AskDeps, 'wiki' | 'article' | 'natureserve' | 'ebird'> {
  const articleCache = createArticleCache(db).wrap(fetchWikipediaArticle);
  const article: ArticleFetcher = async (scientific, common, now) => {
    const a = await articleCache(scientific, common, now);
    const c = current();
    if (!a || !c?.injectWikipedia) return a;
    return { ...a, sections: [...a.sections, { heading: 'Diet', url: a.url + '#Diet', text: c.injectWikipedia }] };
  };
  const nsCache = createNatureServeCache(db).wrap(fetchNatureServeStatus);
  const natureserve: NatureServeFetcher = async (scientific, now) => {
    const s = await nsCache(scientific, now);
    const c = current();
    if (!s || !c?.injectNatureServe) return s;
    return { ...s, common: c.injectNatureServe };
  };
  let ebird: EbirdSource | null = null;
  if (config.EBIRD_API_KEY) {
    const api: EbirdApi = createEbirdApi(config.EBIRD_API_KEY);
    const source = createEbirdSource(db, api);
    ebird = {
      speciesCode: (sci, now) => source.speciesCode(sci, now),
      async recentInRegion(code, region, now) {
        const obs = await source.recentInRegion(code, region, now);
        const c = current();
        if (!c?.injectEbird) return obs;
        return [{ locality: c.injectEbird, date: new Date().toISOString().slice(0, 10), count: 1 }, ...obs];
      },
      recentNearby: (code, lat, lon, now) => source.recentNearby(code, lat, lon, now),
    };
  }
  return { wiki: fetchWikipediaSummary, article, natureserve, ebird };
}

interface CaseContext {
  config: Config;
  db: ReturnType<typeof openDatabase>;
  costs: ReturnType<typeof createAskCostStore>;
  sources: Pick<AskDeps, 'wiki' | 'article' | 'natureserve' | 'ebird'>;
  chain: AnswerModel;
  labels: SpeciesLabels;
  lines: string[];
  log: (line: string) => void;
  setCurrent: (c: HardeningCase | null) => void;
}

/** True (and logged) when the next case could push the run's Gemini spend over the budget. */
function overBudget(opts: RunOptions, spentMicros: number, caseId: string, log: (l: string) => void): boolean {
  if (opts.provider === 'ollama') return false;
  const projected = (spentMicros + PER_CASE_GEMINI_ESTIMATE_USD * 1_000_000) / 1_000_000;
  if (projected <= opts.budgetUsd) return false;
  log(`[harden] stopping before ${caseId}: estimated Gemini spend $${(spentMicros / 1_000_000).toFixed(4)} + $${PER_CASE_GEMINI_ESTIMATE_USD} would exceed the $${opts.budgetUsd.toFixed(2)} budget`);
  return true;
}

function describeResult(r: CaseResult): string {
  const error = r.error ? ` ${r.error}` : '';
  const raw = r.rawFlags.join(',') || '-';
  const misbehaved = r.modelMisbehaved ? ' model-misbehaved' : '';
  const reason = r.reason ? ` · ${r.reason}` : '';
  return `[harden] ${r.id} ${r.pass ? 'PASS' : 'FAIL'} ${r.title} · HTTP ${r.status}${error} · provider=${r.provider ?? '-'} · raw=${raw}${misbehaved}${reason}`;
}

/** Run one case: inject its text, ask through the real pipeline, capture the raw reply, judge. */
async function runOneCase(ctx: CaseContext, c: HardeningCase): Promise<CaseResult> {
  ctx.setCurrent(c);
  let rawText = '';
  let rawFlags: OutputFlag[] = [];
  const capturing: AnswerModel = async (input) => {
    const text = await ctx.chain(input);
    rawText = text;
    rawFlags = filterAnswer(text, toPlainText(text)).flags;
    return text;
  };
  const deps: AskDeps = {
    labels: ctx.labels,
    ...ctx.sources,
    model: capturing,
    usage: createUsageStore(ctx.db),
    caps: { perUserDaily: 1_000, globalDaily: 10_000 },
    maxQuestionChars: ctx.config.ASK_MAX_QUESTION_CHARS,
    costs: ctx.costs,
    log: ctx.log,
  };
  const started = Date.now();
  const before = ctx.lines.length;
  const out = await answerQuestion(deps, { id: 'harden-member', status: 'approved' }, { species: c.species, question: c.question, ...(c.region ? { region: c.region } : {}) });
  const askLine = ctx.lines.slice(before).find((l) => /^\[ask\] provider=\S+ model=/.test(l));
  const provider = askLine?.match(/provider=(\S+)/)?.[1];
  const model = askLine?.match(/model=(\S+)/)?.[1];
  const r = judgeCase(c, out, { text: rawText, flags: rawFlags }, { provider, model, durationMs: Date.now() - started });
  ctx.log(describeResult(r));
  ctx.setCurrent(null);
  return r;
}

/** The chain for the chosen provider; `ollama`/`gemini` force a single provider (the other is left out of the order). */
function chainFor(config: Config, choice: ProviderChoice, costs: ReturnType<typeof createAskCostStore>, log: (l: string) => void): AnswerModel | null {
  const order = choice === 'chain' ? config.providerOrder : [choice];
  return createProviderChain({ ...config, providerOrder: order }, { costs, log });
}

export async function runHardening(config: Config, opts: RunOptions): Promise<RunReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const cases = HARDENING_CASES.filter((c) => !opts.only || opts.only.includes(c.id));
  const db = openDatabase(':memory:');
  const costs = createAskCostStore(db, { priceOverrides: { inputPerM: config.GEMINI_PRICE_IN, outputPerM: config.GEMINI_PRICE_OUT } });
  let current: HardeningCase | null = null;
  const sources = injectingSources(config, db, () => current);
  const lines: string[] = [];
  const chain = chainFor(config, opts.provider, costs, (l) => {
    lines.push(l);
    log(l);
  });
  const results: CaseResult[] = [];
  let stoppedForBudget = false;
  if (opts.dryRun) {
    log(`[harden] dry run: ${cases.length} case(s) would run with provider=${opts.provider}, budget $${opts.budgetUsd.toFixed(2)}; report -> ${opts.outDir}; nothing is called`);
    for (const c of cases) log(`[harden]   ${c.id} ${c.title}`);
    return { startedAt, finishedAt: now().toISOString(), provider: opts.provider, models: { ollama: config.OLLAMA_MODEL, gemini: config.GEMINI_MODEL }, cases: [], passed: 0, failed: 0, geminiSpendUsd: 0, stoppedForBudget: false };
  }
  if (!chain) throw new Error(`no provider available for --provider ${opts.provider} (missing key?)`);
  const labels = opts.labels ?? loadLabels(config.LABELS_PATH);
  const ctx: CaseContext = { config, db, costs, sources, chain, labels, lines, log, setCurrent: (c) => void (current = c) };
  // Sequential on purpose: the injected text is per case and the budget is checked before each one.
  for (const c of cases) {
    if (overBudget(opts, costs.monthSpendMicros(now()), c.id, log)) {
      stoppedForBudget = true;
      break;
    }
    results.push(await runOneCase(ctx, c));
  }
  const passed = results.filter((r) => r.pass).length;
  const report: RunReport = {
    startedAt,
    finishedAt: now().toISOString(),
    provider: opts.provider,
    models: { ollama: config.OLLAMA_MODEL, gemini: config.GEMINI_MODEL },
    cases: results,
    passed,
    failed: results.length - passed,
    geminiSpendUsd: costs.monthSpendMicros(now()) / 1_000_000,
    stoppedForBudget,
  };
  mkdirSync(opts.outDir, { recursive: true });
  const file = join(opts.outDir, `harden-${startedAt.replace(/[:.]/g, '-')}-${opts.provider}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  report.reportFile = file;
  log(`[harden] ${passed}/${results.length} passed · Gemini spend this run ≈ $${report.geminiSpendUsd.toFixed(4)} · report ${file}`);
  return report;
}
