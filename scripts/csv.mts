/** Shared by scripts/prepare-labels-v3.mts and scripts/prepare-names-v3.mts. */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A downloaded input file named on the command line, read only when it is a regular file with the expected extension
 * under the current folder (run the scripts from the repository root with the downloads inside it).
 */
export function readInputFile(arg: string, extension: string): string {
  const resolved = path.resolve(process.cwd(), arg);
  const inside = resolved.startsWith(process.cwd() + path.sep);
  if (!inside || path.extname(resolved) !== extension || !fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`expected a ${extension} file inside ${process.cwd()}: ${arg}`);
  }
  return fs.readFileSync(resolved, 'utf8').replace(/^﻿/, '');
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
