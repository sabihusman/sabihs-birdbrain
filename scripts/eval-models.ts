/**
 * Compare two Gemini models on the /v1/ask pipeline: 20 fixed questions across
 * 5 species, the same Wikipedia context for both, answers, tokens and cost
 * side by side as a Markdown table (server/src/eval-models.ts has the pieces).
 *
 *   GEMINI_API_KEY=… npx tsx scripts/eval-models.ts [--dry-run] [--models a,b] [--budget 0.10]
 *
 * The key is read from the environment only. The estimated cost is printed
 * first and the run is refused above the budget (default $0.10). --dry-run
 * prints the plan and the question list and makes no network call at all.
 * Questions and answers are printed to stdout on purpose: this is an
 * evaluation, not the server log.
 */
import { createGeminiModel } from '../server/src/ask';
import { EVAL_BUDGET_USD, EVAL_MODELS, EVAL_QUESTIONS, formatPlan, formatResults, planRun, runEval, UsageCollector } from '../server/src/eval-models';
import { loadLabels } from '../server/src/labels';
import { fetchWikipediaArticle } from '../server/src/wiki-article';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const models = (arg('--models') ?? EVAL_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const budget = Number(arg('--budget') ?? EVAL_BUDGET_USD);
  const plan = planRun(models, EVAL_QUESTIONS, undefined, budget);
  console.log(`# Model evaluation plan (${EVAL_QUESTIONS.length} questions × ${models.length} models)\n`);
  console.log(formatPlan(plan));
  console.log('');
  if (dryRun) {
    console.log('## Questions\n');
    for (const q of EVAL_QUESTIONS) console.log(`- ${q.species}: ${q.question}`);
    console.log('\nDry run: no API call made.');
    return;
  }
  if (!plan.withinBudget) {
    console.error('Refusing to run: the estimate is over budget or a model has no price (add it to server/src/pricing.ts).');
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in the environment.');
    process.exitCode = 2;
    return;
  }
  const labels = loadLabels('public/models/birdnet-v2.4/labels.json');
  const runs = models.map((model) => {
    const collector = new UsageCollector();
    // Per-call lines go to stderr so stdout stays a clean Markdown document.
    return { model, collector, answer: createGeminiModel(apiKey, model, undefined, (line) => console.error(`${model} ${line}`), collector) };
  });
  const rows = await runEval({ labels, article: fetchWikipediaArticle, models: runs }, EVAL_QUESTIONS);
  console.log('## Results\n');
  console.log(formatResults(rows, models));
}

main().catch((err: unknown) => {
  // Never print the error object: an SDK error can embed the request, including the key.
  console.error(`eval failed: ${err instanceof Error ? err.message.replace(/key=[^&\s]+/gi, 'key=…') : 'unknown error'}`);
  process.exitCode = 1;
});
