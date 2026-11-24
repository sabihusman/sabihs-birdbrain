/** Shared by scripts/prepare-labels-v3.mts and scripts/prepare-names-v3.mts. */

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  // One field and what ends it: a comma, a line break, or the end of the text.
  const field = /("(?:[^"]|"")*"|[^,\r\n]*)(,|\r?\n|$)/g;
  for (let m = field.exec(text); m !== null && m.index < text.length; m = field.exec(text)) {
    const raw = m[1];
    row.push(raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw);
    if (m[2] !== ',') {
      rows.push(row);
      row = [];
    }
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}
