/**
 * Compare models on the /v1/ask pipeline: 20 fixed questions across 5 species
 * plus 4 adversarial cases (injection through the question and through the
 * article, a system-prompt leak request, a markup request), the same Wikipedia
 * context for every model, answers, tokens, cost and flags side by side as a
 * Markdown table (server/src/eval-models.ts and eval-adversarial.ts have the
 * pieces).
 *
 *   GEMINI_API_KEY=… OLLAMA_API_KEY=… npx tsx scripts/eval-models.ts [--dry-run] [--models a,b] [--ollama gemma4:31b | --no-ollama] [--budget 0.10]
 *
 * Keys are read from the environment only. Gemini models are priced and the
 * run is refused above the budget (default $0.10); the Ollama Cloud model
 * (default: OLLAMA_MODEL, else gemma4:31b) draws on the plan's allowance and is
 * listed as "plan allowance" in the plan. --dry-run prints the plan and the
 * question list and makes no network call at all. Questions and answers are
 * printed to stdout on purpose: this is an evaluation, not the server log.
 * Flags in the table: provider_error, empty, cut_off, leak, injected, markup.
 */
import { createGeminiModel } from '../server/src/ask';
import { ADVERSARIAL_CASES } from '../server/src/eval-adversarial';
import { EVAL_BUDGET_USD, EVAL_MODELS, EVAL_QUESTIONS, formatPlan, formatResults, planRun, runEval, UsageCollector } from '../server/src/eval-models';
import { loadLabels } from '../server/src/labels';
import { createChain } from '../server/src/providers/index';
import { createOllamaGenerator } from '../server/src/providers/ollama';
import { fetchWikipediaArticle } from '../server/src/wiki-article';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DEFAULT_OLLAMA_MODEL = 'gemma4:31b';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const geminiModels = (arg('--models') ?? EVAL_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const ollamaModel = process.argv.includes('--no-ollama') ? null : (arg('--ollama') ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL);
  const budget = Number(arg('--budget') ?? EVAL_BUDGET_USD);
  const questions = [...EVAL_QUESTIONS, ...ADVERSARIAL_CASES];
  const plan = planRun(geminiModels, questions, undefined, budget);
  const columns = [...geminiModels, ...(ollamaModel ? [`ollama:${ollamaModel}`] : [])];
  console.log(`# Model evaluation plan (${EVAL_QUESTIONS.length} questions + ${ADVERSARIAL_CASES.length} adversarial cases × ${columns.length} models)\n`);
  console.log(formatPlan(plan));
  if (ollamaModel) console.log(`\nOllama Cloud: ${ollamaModel}, ${questions.length} calls, plan allowance (not priced; see https://ollama.com/settings/usage).`);
  console.log('');
  if (dryRun) {
    console.log('## Questions\n');
    for (const q of EVAL_QUESTIONS) console.log(`- ${q.species}: ${q.question}`);
    console.log('\n## Adversarial cases (a flag in the results means the model misbehaved)\n');
    for (const q of ADVERSARIAL_CASES) console.log(`- ${q.kind}: ${q.question}${q.injectArticle ? ' (with an injected article section)' : ''}`);
    console.log('\nDry run: no API call made.');
    return;
  }
  if (!plan.withinBudget) {
    console.error('Refusing to run: the estimate is over budget or a Gemini model has no price (add it to server/src/pricing.ts).');
    process.exitCode = 2;
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (geminiModels.length && !apiKey) {
    console.error('GEMINI_API_KEY is not set in the environment.');
    process.exitCode = 2;
    return;
  }
  const ollamaKey = process.env.OLLAMA_API_KEY;
  if (ollamaModel && !ollamaKey) {
    console.error('OLLAMA_API_KEY is not set in the environment (pass --no-ollama to skip the Ollama column).');
    process.exitCode = 2;
    return;
  }
  const labels = loadLabels('public/models/birdnet-v2.4/labels.json');
  // Per-call lines go to stderr so stdout stays a clean Markdown document.
  const runs = geminiModels.map((model) => {
    const collector = new UsageCollector();
    return { model, collector, answer: createGeminiModel(apiKey!, model, undefined, (line) => console.error(`${model} ${line}`), collector) };
  });
  if (ollamaModel && ollamaKey) {
    const collector = new UsageCollector();
    const name = `ollama:${ollamaModel}`;
    const chain = createChain([{ name: 'ollama', generate: createOllamaGenerator({ apiKey: ollamaKey, model: ollamaModel, timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 8000) }) }], {
      log: (line) => console.error(`${name} ${line}`),
      providerUsage: {
        record: (provider, _from, usage) => {
          collector.record(name, { promptTokens: usage.promptTokens ?? 0, answerTokens: usage.answerTokens ?? 0, thinkingTokens: 0, cachedTokens: 0 });
          return { provider, requests: collector.calls, promptTokens: collector.usage.promptTokens, answerTokens: collector.usage.answerTokens, fallbacks: 0 };
        },
        days: () => [],
        totals: () => [],
      },
    });
    runs.push({ model: name, collector, answer: chain });
  }
  const rows = await runEval({ labels, article: fetchWikipediaArticle, models: runs }, questions);
  console.log('## Results\n');
  console.log(formatResults(rows, columns));
}

main().catch((err: unknown) => {
  // Never print the error object: an SDK error can embed the request, including the key.
  console.error(`eval failed: ${err instanceof Error ? err.message.replace(/key=[^&\s]+/gi, 'key=…') : 'unknown error'}`);
  process.exitCode = 1;
});
