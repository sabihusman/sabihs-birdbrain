/**
 * The state/province codes the app may send with a question. The client
 * decides the code on the device from its location (src/geo/region.ts) and
 * sends only the code; the server never sees a precise position. The codes are
 * ISO 3166-2, which is also what NatureServe's `subnationCode` (without the
 * nation prefix) and eBird's subnational1 region codes use.
 */
export const REGION_CODES = ['US-IA', 'US-IL', 'US-WA', 'CA-AB', 'CA-ON'] as const;
export type RegionCode = (typeof REGION_CODES)[number];
export type Region = RegionCode | 'none';

export const REGION_NAMES: Record<RegionCode, string> = {
  'US-IA': 'Iowa',
  'US-IL': 'Illinois',
  'US-WA': 'Washington',
  'CA-AB': 'Alberta',
  'CA-ON': 'Ontario',
};

export function isRegionCode(s: string): s is RegionCode {
  return (REGION_CODES as readonly string[]).includes(s);
}

/** "Iowa (US-IA)" for prompts and notes. */
export function describeRegion(code: RegionCode): string {
  return `${REGION_NAMES[code]} (${code})`;
}
