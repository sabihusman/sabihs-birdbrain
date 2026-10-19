/**
 * Model comparison for /v1/ask: the same 20 questions, the same context,
 * against two models; answers, tokens and cost side by side. The pure parts
 * (question set, cost plan, table) live here so the server tests cover them;
 * `scripts/eval-models.ts` at the repository root is the command.
 */
import { ANSWER_MAX_OUTPUT_TOKENS, answerQuestion, SYSTEM_INSTRUCTION, type AnswerModel, type AskOutcome } from './ask.js';
import type { AskCostStore, MonthStatus } from './ask-cost.js';
import { CONTEXT_TOKEN_BUDGET, estimateTokens } from './context-select.js';
import type { UsageStore } from './db.js';
import { flagAnswer, formatFlags, type AdversarialCase, type EvalFlag, type RawReply } from './eval-adversarial.js';
import type { SpeciesLabels } from './labels.js';
import { costMicros, FLASH_LITE_MODEL, formatUsd, priceFor, type TokenUsage } from './pricing.js';
import { ProviderError } from './providers/ollama.js';
import type { ArticleFetcher, WikiArticle } from './wiki-article.js';

export const EVAL_MODELS: ReadonlyArray<string> = ['gemini-3.8-flash', FLASH_LITE_MODEL];
export const EVAL_BUDGET_USD = 0.1;

export interface EvalQuestion {
  species: string;
  question: string;
}

/** Five species with substantial English Wikipedia articles, four questions each. */
export const EVAL_QUESTIONS: ReadonlyArray<EvalQuestion> = [
  { species: 'Turdus merula', question: 'What does it eat?' },
  { species: 'Turdus merula', question: 'When does it breed and how many eggs does it lay?' },
  { species: 'Turdus merula', question: 'How can I tell the male from the female?' },
  { species: 'Turdus merula', question: 'Is it migratory?' },
  { species: 'Parus major', question: 'What does its song sound like?' },
  { species: 'Parus major', question: 'Where does it nest?' },
  { species: 'Parus major', question: 'What is its conservation status?' },
  { species: 'Parus major', question: 'How big is it?' },
  { species: 'Erithacus rubecula', question: 'Why is it so tame around people?' },
  { species: 'Erithacus rubecula', question: 'Does it sing in winter?' },
  { species: 'Erithacus rubecula', question: 'What is its range?' },
  { species: 'Erithacus rubecula', question: 'How long does it live?' },
  { species: 'Cyanocitta cristata', question: 'Does it mimic other birds?' },
  { species: 'Cyanocitta cristata', question: 'What habitat does it prefer?' },
  { species: 'Cyanocitta cristata', question: 'Does it store food?' },
  { species: 'Cyanocitta cristata', question: 'What colour are its feathers really?' },
  { species: 'Haemorhous mexicanus', question: 'How did it spread across North America?' },
  { species: 'Haemorhous mexicanus', question: 'What gives the male its red colour?' },
  { species: 'Haemorhous mexicanus', question: 'What diseases affect it?' },
  { species: 'Haemorhous mexicanus', question: 'What is the capital of France?' },
];

export interface PlanAssumptions {
  /** Prompt tokens per call: instruction + species line + context budget + question. */
  promptTokens: number;
  /** Visible answer tokens per call (the instruction asks for at most 120 words). */
  answerTokens: number;
  /** Thinking tokens per call at the lowest level. */
  thinkingTokens: number;
}

export const DEFAULT_ASSUMPTIONS: PlanAssumptions = {
  promptTokens: estimateTokens(SYSTEM_INSTRUCTION) + CONTEXT_TOKEN_BUDGET + 60,
  answerTokens: 200,
  thinkingTokens: 150,
};

export interface ModelPlan {
  model: string;
  calls: number;
  usage: TokenUsage;
  /** Estimated cost in micro-dollars; null when the model has no price (the run is refused). */
  costMicros: number | null;
}

export interface Plan {
  models: ModelPlan[];
  totalMicros: number | null;
  budgetMicros: number;
  withinBudget: boolean;
}

/** The worst-case cost of a run, before any call is made. */
export function planRun(models: ReadonlyArray<string>, questions: ReadonlyArray<EvalQuestion>, a: PlanAssumptions = DEFAULT_ASSUMPTIONS, budgetUsd = EVAL_BUDGET_USD): Plan {
  const n = questions.length;
  const plans: ModelPlan[] = models.map((model) => {
    const usage: TokenUsage = { promptTokens: a.promptTokens * n, answerTokens: Math.min(a.answerTokens, ANSWER_MAX_OUTPUT_TOKENS) * n, thinkingTokens: a.thinkingTokens * n, cachedTokens: 0 };
    return { model, calls: n, usage, costMicros: costMicros(model, usage) };
  });
  const totalMicros = plans.every((p) => p.costMicros !== null) ? plans.reduce((s, p) => s + (p.costMicros ?? 0), 0) : null;
  const budgetMicros = Math.round(budgetUsd * 1_000_000);
  return { models: plans, totalMicros, budgetMicros, withinBudget: totalMicros !== null && totalMicros <= budgetMicros };
}

export function formatPlan(plan: Plan): string {
  const lines = ['| Model | Calls | Prompt tokens | Output tokens (answer + thinking) | Estimated cost (USD) |', '|---|---:|---:|---:|---:|'];
  for (const m of plan.models) {
    const price = priceFor(m.model);
    const note = price ? '' : ' (unknown price)';
    lines.push(`| ${m.model} | ${m.calls} | ${m.usage.promptTokens} | ${m.usage.answerTokens + m.usage.thinkingTokens} | ${formatUsd(m.costMicros)}${note} |`);
  }
  lines.push('', `Total: ${formatUsd(plan.totalMicros)} USD, budget ${formatUsd(plan.budgetMicros)} USD: ${plan.withinBudget ? 'within budget' : 'OVER BUDGET, refusing to run'}`);
  return lines.join('\n');
}

export interface EvalAnswer {
  model: string;
  answer: string;
  usage: TokenUsage;
  costMicros: number | null;
  calls: number;
  /** Misbehaviours seen in the raw reply (eval-adversarial.ts); empty when the answer is clean. */
  flags: EvalFlag[];
}

export interface EvalRow {
  question: EvalQuestion;
  answers: EvalAnswer[];
}

/** Collects what createGeminiModel reports per call, in place of the SQLite store. */
export class UsageCollector implements AskCostStore {
  calls = 0;
  usage: TokenUsage = { promptTokens: 0, answerTokens: 0, thinkingTokens: 0, cachedTokens: 0 };
  /** Null once any call went to a model outside the Gemini price table (an Ollama model: "plan allowance" in the table). */
  costMicros: number | null = 0;
  record(model: string, usage: TokenUsage): number {
    this.calls++;
    this.usage.promptTokens += usage.promptTokens;
    this.usage.answerTokens += usage.answerTokens;
    this.usage.thinkingTokens += usage.thinkingTokens;
    this.usage.cachedTokens += usage.cachedTokens;
    const cost = costMicros(model, usage);
    this.costMicros = cost === null || this.costMicros === null ? null : this.costMicros + cost;
    return cost ?? 0;
  }
  recordCacheHit(): void {}
  summary(): never[] {
    return [];
  }
  // The eval has no month or cap: the collector's running total stands in, and no alert is ever recorded.
  monthSpendMicros(): number {
    return this.costMicros ?? 0;
  }
  monthStatus(capMicros: number): MonthStatus {
    const spentMicros = this.costMicros ?? 0;
    return { month: new Date().toISOString().slice(0, 7), spentMicros, capMicros, percent: capMicros > 0 ? Math.floor((spentMicros * 100) / capMicros) : 100, alertsSent: [] };
  }
  markAlert(): boolean {
    return false;
  }
  reset(): void {
    this.calls = 0;
    this.usage = { promptTokens: 0, answerTokens: 0, thinkingTokens: 0, cachedTokens: 0 };
    this.costMicros = 0;
  }
}

/** A usage store that never caps: the eval has its own budget. */
export const unlimitedUsage: UsageStore = { get: () => 0, record: () => undefined };

export interface EvalDeps {
  labels: SpeciesLabels;
  article: ArticleFetcher;
  /** One answer model per evaluated model id (Gemini id or "ollama:<model>"), each reporting into its collector. */
  models: Array<{ model: string; answer: AnswerModel; collector: UsageCollector }>;
}

/** An adversarial case's injected text as one more article section, worded so the selector picks it. */
function withInjectedSection(article: WikiArticle, injected: string): WikiArticle {
  return { ...article, sections: [...article.sections, { heading: 'Diet and feeding notes', url: `${article.url}#Diet`, text: injected }] };
}

function describeOutcome(out: AskOutcome): string {
  return out.status === 200 ? out.body.answer : `(error ${out.status}: ${out.body.error})`;
}

/**
 * Run every question (bird questions and adversarial cases alike) through the
 * real pipeline against each model; the article is fetched once per species.
 * The raw reply of each call is captured before the server's output rules so
 * the flags describe the model's behaviour, not the sanitised result.
 */
export async function runEval(deps: EvalDeps, questions: ReadonlyArray<EvalQuestion | AdversarialCase> = EVAL_QUESTIONS): Promise<EvalRow[]> {
  const articles = new Map<string, ReturnType<ArticleFetcher>>();
  const article: ArticleFetcher = (sci, common, now) => {
    let p = articles.get(sci);
    if (!p) {
      p = deps.article(sci, common, now);
      articles.set(sci, p);
    }
    return p;
  };
  const wiki = async () => null;
  const rows: EvalRow[] = [];
  for (const q of questions) {
    const adv = 'kind' in q ? q : undefined;
    const fetcher: ArticleFetcher = adv?.injectArticle ? async (sci, common, now) => {
      const a = await article(sci, common, now);
      return a ? withInjectedSection(a, adv.injectArticle!) : a;
    } : article;
    const answers: EvalAnswer[] = [];
    for (const m of deps.models) {
      m.collector.reset();
      const raw: RawReply = {};
      const probe: AnswerModel = async (input) => {
        try {
          raw.text = await m.answer(input);
          return raw.text;
        } catch (err) {
          raw.error = err instanceof ProviderError ? err.kind : 'error';
          throw err;
        }
      };
      const out = await answerQuestion({ labels: deps.labels, wiki, article: fetcher, model: probe, usage: unlimitedUsage, caps: { perUserDaily: 1e9, globalDaily: 1e9 }, maxQuestionChars: 500 }, { id: 'eval', status: 'approved' }, { species: q.species, question: q.question });
      answers.push({ model: m.model, answer: describeOutcome(out), usage: { ...m.collector.usage }, costMicros: m.collector.costMicros, calls: m.collector.calls, flags: flagAnswer(raw, out, adv?.marker) });
    }
    rows.push({ question: { species: q.species, question: q.question }, answers });
  }
  return rows;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** Markdown: one row per question, one answer column and one tokens/cost column per model, then totals. */
export function formatResults(rows: ReadonlyArray<EvalRow>, models: ReadonlyArray<string>): string {
  const head = ['Species', 'Question', ...models.flatMap((m) => [`${m} answer`, `${m} tokens (prompt/answer/thinking) · cost`])];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  const totals = new Map(models.map((m) => [m, { calls: 0, usage: { promptTokens: 0, answerTokens: 0, thinkingTokens: 0, cachedTokens: 0 } as TokenUsage, costMicros: 0 as number | null }]));
  for (const r of rows) {
    const cells = [r.question.species, cell(r.question.question)];
    for (const m of models) {
      const a = r.answers.find((x) => x.model === m);
      if (!a) {
        cells.push('(no answer)', '-');
        continue;
      }
      cells.push(formatFlags(a.flags) + cell(a.answer), `${a.usage.promptTokens}/${a.usage.answerTokens}/${a.usage.thinkingTokens} · ${formatUsd(a.costMicros)}`);
      const t = totals.get(m)!;
      t.calls += a.calls;
      t.usage.promptTokens += a.usage.promptTokens;
      t.usage.answerTokens += a.usage.answerTokens;
      t.usage.thinkingTokens += a.usage.thinkingTokens;
      t.usage.cachedTokens += a.usage.cachedTokens;
      t.costMicros = t.costMicros === null || a.costMicros === null ? null : t.costMicros + a.costMicros;
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('', '| Model | Calls | Prompt tokens | Answer tokens | Thinking tokens | Cached tokens | Cost (USD) | Flagged answers |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [m, t] of totals) {
    const flagged = rows.reduce((n, r) => n + (r.answers.find((a) => a.model === m)?.flags.length ? 1 : 0), 0);
    lines.push(`| ${m} | ${t.calls} | ${t.usage.promptTokens} | ${t.usage.answerTokens} | ${t.usage.thinkingTokens} | ${t.usage.cachedTokens} | ${formatUsd(t.costMicros)} | ${flagged} |`);
  }
  return lines.join('\n');
}
