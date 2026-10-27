/**
 * Plain text from the small HTML snippets Wikipedia and Commons send: the page's `displaytitle`
 * and the image's `Artist` / `Credit` / `LicenseShortName` / `LicenseUrl`. Removing the tags is not
 * enough: the text inside still carries character references, so "Swainson&#039;s thrush" or
 * "Smith &amp; Jones" would show as typed. Decoded here without a DOM, so it also runs in tests.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** Tags removed, references decoded, spaces collapsed; null for nothing. */
export function htmlToText(s: string | null | undefined): string | null {
  if (!s) return null;
  const text = decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  return text || null;
}
