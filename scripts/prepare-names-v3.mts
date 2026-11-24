/**
 * Make public/models/birdnet-v3.0/v24-names.json: for each V2.4 bird whose scientific name is not in BirdNET+ V3.0,
 * the V3.0 name it became (DECISIONS.md #136). The app uses it to show a bird saved under V2.4 together with the
 * same bird found by V3.0, without changing what is stored.
 *
 *   npx tsx scripts/prepare-names-v3.mts <BirdNET+_Taxonomy_v0.5-Nov2026.csv>
 *
 * In this order: the taxonomy's own `scientific_name_aliases` (old names it lists for a species); then the same
 * English name (genus moves such as "Accipiter superciliosus" → "Microspizias superciliosus"); then MANUAL below, each
 * checked by hand against the taxonomy. A bird with none of these stays under its old name.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCsv } from './csv.mts';

/**
 * Checked by hand (Nov 24, 2026) for birds the first two steps missed: spelling ("Gray" → "Grey") or genus moves the
 * taxonomy lists under a slightly different English name. (The taxonomy's own aliases already cover the lumps, such as
 * Lesser and Hoary Redpoll into "Redpoll" and the three swamphens into Western Swamphen.) Left unmapped because the
 * V3.0 bird is not clearly the same or is not among the model's classes: Island Thrush (split), Rufous Shrikethrush,
 * Rusty-breasted Whistler, Himalayan Shrike-Babbler, Yellow-billed Barbet, Southern and Variegated Bristle-Tyrant.
 *
 * The output is derived from the BirdNET+ Taxonomy v0.5-Nov2026 (CC BY-SA 4.0), so it carries that licence.
 */
const MANUAL: Record<string, string> = {
  'Acanthis cabaret': 'Acanthis flammea',
  'Acanthis hornemanni': 'Acanthis flammea',
  'Brachypodius priocephalus': 'Microtarsus priocephalus',
  'Coracina caesia': 'Ceblepyris caesius',
  'Corythaixoides concolor': 'Crinifer concolor',
  'Phylloscartes lanyoni': 'Pogonotriccus lanyoni',
  'Phylloscartes ophthalmicus': 'Pogonotriccus ophthalmicus',
};

const root = path.resolve(import.meta.dirname, '..');
const taxPath = process.argv[2];
if (!taxPath) {
  console.error('usage: npx tsx scripts/prepare-names-v3.mts <BirdNET+_Taxonomy_v0.5-Nov2026.csv>');
  process.exit(2);
}
const v24 = (JSON.parse(fs.readFileSync(path.join(root, 'public/models/birdnet-v2.4/labels.json'), 'utf8')) as string[])
  .map((l) => l.split('_'))
  .filter(([sci, common]) => sci !== common);
const v3 = (JSON.parse(fs.readFileSync(path.join(root, 'public/models/birdnet-v3.0/labels.json'), 'utf8')) as { classes: [string, string, string, number][] }).classes;
const inV3 = new Set(v3.map((c) => c[0]));
const v3ByCommon = new Map<string, string>();
for (const [sci, common] of v3) if (!v3ByCommon.has(common.toLowerCase())) v3ByCommon.set(common.toLowerCase(), sci);

const [header, ...rows] = parseCsv(fs.readFileSync(taxPath, 'utf8').replace(/^\uFEFF/, ''));
const sciCol = header.indexOf('scientific_name');
const aliasCol = header.indexOf('scientific_name_aliases');
const aliasOf = new Map<string, string>();
for (const r of rows) {
  // Old names separated by "|", e.g. "Acanthis cabaret|Carduelis flammea|Acanthis hornemanni".
  for (const old of r[aliasCol].split('|').map((x) => x.trim()).filter(Boolean)) {
    if (inV3.has(r[sciCol]) && !aliasOf.has(old)) aliasOf.set(old, r[sciCol]);
  }
}

const map: Record<string, string> = {};
const counts = { alias: 0, common: 0, manual: 0, none: 0 };
for (const [sci, common] of v24) {
  if (inV3.has(sci)) continue;
  const viaAlias = aliasOf.get(sci);
  const viaCommon = v3ByCommon.get(common.toLowerCase());
  const viaManual = MANUAL[sci];
  const target = viaAlias ?? viaCommon ?? viaManual;
  if (target && !inV3.has(target)) throw new Error(`${sci} → ${target}, which is not in V3.0`);
  if (target) map[sci] = target;
  counts[viaAlias ? 'alias' : viaCommon ? 'common' : viaManual ? 'manual' : 'none']++;
}
const out = path.join(root, 'public/models/birdnet-v3.0/v24-names.json');
fs.writeFileSync(out, JSON.stringify(map, Object.keys(map).sort(), 0));
console.log(counts, `wrote ${out}`);
