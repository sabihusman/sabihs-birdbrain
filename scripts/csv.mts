/** Shared by scripts/prepare-labels-v3.mts and scripts/prepare-names-v3.mts. */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where the downloaded inputs go (gitignored): the files exactly as named in Zenodo record 24362980. */
export const SOURCE_DIR = path.resolve(import.meta.dirname, '../.downloads/birdnet-v3.0');

/** One downloaded input by its file name in SOURCE_DIR, without a byte-order mark. */
export function readSource(fileName: string): string {
  return fs.readFileSync(path.join(SOURCE_DIR, fileName), 'utf8').replace(/^\uFEFF/, '');
}

/** Where a quoted field ends: the index of its closing quote (a doubled quote "" is a quote inside the field). */
function closingQuote(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] === '"' && text[i + 1] === '"') i += 2;
    else if (text[i] === '"') return i;
    else i++;
  }
  return text.length;
}

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. One pass, no backtracking. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < text.length) {
    let value: string;
    if (text[i] === '"') {
      const end = closingQuote(text, i + 1);
      value = text.slice(i + 1, end).replaceAll('""', '"');
      i = end + 1;
    } else {
      let end = i;
      while (end < text.length && text[end] !== ',' && text[end] !== '\n' && text[end] !== '\r') end++;
      value = text.slice(i, end);
      i = end;
    }
    row.push(value);
    if (text[i] === ',') {
      i++;
      continue;
    }
    // End of the line (\r\n or \n) or of the text.
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    rows.push(row);
    row = [];
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}
