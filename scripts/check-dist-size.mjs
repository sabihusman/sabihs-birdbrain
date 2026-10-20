/**
 * Guard for the model move (DECISIONS.md #56): the built front end must stay small and
 * must not contain BirdNET weights, which are served from the API host instead.
 * Run after `npm run build`; CI runs it on every push.
 *
 *   node scripts/check-dist-size.mjs [dist] [--max-mib 12]
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const dist = args.find((a) => !a.startsWith('--')) ?? 'dist';
const maxIdx = args.indexOf('--max-mib');
const MAX_MIB = maxIdx === -1 ? 12 : Number(args[maxIdx + 1]);
const MIB = 1024 * 1024;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push({ path: p, size: statSync(p).size });
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch (e) {
  console.error(`cannot read ${dist}: ${e.message}\nRun "npm run build" first.`);
  process.exit(2);
}

const total = files.reduce((sum, f) => sum + f.size, 0);
const weights = files.filter((f) => /[\\/]models[\\/].*\.bin$/.test(f.path) || /group1-shard\d+of\d+\.bin$/.test(f.path));
const modelJson = files.filter((f) => /[\\/]models[\\/].*[\\/]?model\.json$/.test(f.path));
const biggest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);

console.log(`dist: ${files.length} files, ${(total / MIB).toFixed(1)} MiB (limit ${MAX_MIB} MiB)`);
for (const f of biggest) console.log(`  ${(f.size / MIB).toFixed(2)} MiB  ${relative(dist, f.path)}`);

const problems = [];
if (weights.length > 0) problems.push(`${weights.length} BirdNET weight file(s) in ${dist}: ${weights.map((f) => relative(dist, f.path)).join(', ')}`);
if (modelJson.length > 0) problems.push(`model topology in ${dist}: ${modelJson.map((f) => relative(dist, f.path)).join(', ')}`);
if (total > MAX_MIB * MIB) problems.push(`${dist} is ${(total / MIB).toFixed(1)} MiB, over the ${MAX_MIB} MiB limit`);

if (problems.length > 0) {
  console.error('\nFAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nThe model files belong on the API host; publish them with scripts/server/publish-model.sh.');
  process.exit(1);
}
console.log('ok: no model weights in the build, size within the limit');
