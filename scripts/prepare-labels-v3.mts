/**
 * Make public/models/birdnet-v3.0/labels.json, the species list the app uses with BirdNET+ V3.0 (DECISIONS.md #133),
 * from the two label files in Zenodo record 24362980:
 *
 *   npx tsx scripts/prepare-labels-v3.mts <BirdNET+_V3.0_Global_12K_Labels.csv> <BirdNET+_Geomodel_V3.0.5_Global_14K_Labels.txt>
 *
 * The CSV has one row per audio-model output (8 MB with names in 36 languages); the app keeps four fields per row:
 * scientific name, English common name, taxon group (Aves, Insecta, …) and the row's index in the location model's
 * output (-1 for the 16 sound classes, which the location model has no output for). The location model has its own
 * class order, so the index is matched by BirdNET ID.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCsv } from './csv.mts';

const [csvPath, geoPath] = process.argv.slice(2);
if (!csvPath || !geoPath) {
  console.error('usage: npx tsx scripts/prepare-labels-v3.mts <12K_Labels.csv> <Geomodel_14K_Labels.txt>');
  process.exit(2);
}
const [header, ...body] = parseCsv(fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, ''));
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`no column ${name} in ${csvPath}`);
  return i;
};
const [ix, id, sci, common, group] = ['ix', 'birdnet_id', 'scientific_name', 'common_name', 'taxon_group'].map(col);

const geoIndex = new Map<string, number>();
fs.readFileSync(geoPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .forEach((line, i) => geoIndex.set(line.split('\t')[0], i));

const classes = body.map((r, i) => {
  if (Number(r[ix]) !== i) throw new Error(`row ${i} has ix ${r[ix]}: the CSV must be in output order`);
  return [r[sci], r[common] || r[sci], r[group], geoIndex.get(r[id]) ?? -1] as const;
});
const missingGeo = classes.filter((c) => c[3] === -1);
const out = path.resolve(import.meta.dirname, '../public/models/birdnet-v3.0/labels.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify({
    model: 'BirdNET+ V3.0 Global 12K, version 3.0.1 (Zenodo 24362980); location model BirdNET+ Geomodel V3.0.5 Global 14K',
    fields: ['scientific', 'common', 'group', 'geoIndex'],
    classes,
  }),
);
console.log(`${classes.length} classes, ${missingGeo.length} without a location-model output:`, [...new Set(missingGeo.map((c) => c[2]))].join(', '));
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KiB)`);
