import type { UsageCount } from '../api/client';

/**
 * Plain names for Admin › Usage (DECISIONS.md #121). The server passes PostHog's raw values on (route names,
 * "iOS|Safari|Mobile", IANA time zones); these turn them into what the approved mockup shows.
 */

/** Route names grouped the way the tabs are. */
const SCREEN_GROUP: Record<string, string> = {
  listen: 'Listen',
  recordings: 'Recordings',
  recording: 'Recordings',
  species: 'Species',
  'species-detail': 'Species',
  'species-history': 'Species',
  map: 'Map',
  settings: 'Settings',
  account: 'Settings',
  'whats-new': 'Settings',
  help: 'Help',
  signin: 'Sign in & sign up',
  signup: 'Sign in & sign up',
  'forgot-password': 'Sign in & sign up',
  'reset-password': 'Sign in & sign up',
  admin: 'Admin',
  'admin-users': 'Admin',
  'admin-usage': 'Admin',
};

const LAYOUT: Record<string, string> = { focus: 'Focus', consolidated: 'Consolidated', dock: 'Dock', birdamp: 'BirdAmp' };
const BACKEND: Record<string, string> = { webgl: 'WebGL (fast)', wasm: 'WASM', cpu: 'CPU (slow)' };
const MIC: Record<string, string> = {
  denied: 'Microphone blocked',
  'no-mic': 'No microphone found',
  insecure: 'Page not secure (no HTTPS)',
  unsupported: 'Browser can’t record',
  busy: 'Microphone in use by another app',
  other: 'Other microphone problem',
};

/** IANA zone → region name; anything else is "Other". */
const ZONES: Array<[RegExp, string]> = [
  [/^America\/(New_York|Detroit|Indiana\/(?!Knox|Tell_City)|Kentucky\/)/, 'US Eastern'],
  [/^America\/(Chicago|Indiana\/(Knox|Tell_City)|Menominee|North_Dakota\/)/, 'US Central'],
  [/^America\/(Denver|Boise|Phoenix)/, 'US Mountain'],
  [/^America\/Los_Angeles$/, 'US Pacific'],
  [/^America\/(Anchorage|Juneau|Sitka|Yakutat|Nome|Metlakatla)$/, 'Alaska'],
  [/^Pacific\/Honolulu$/, 'Hawaii'],
  [/^America\/(Toronto|Montreal|Nipigon|Thunder_Bay|Iqaluit)$/, 'Canada Eastern'],
  [/^America\/(Winnipeg|Regina|Swift_Current|Rankin_Inlet|Resolute)$/, 'Canada Central'],
  [/^America\/(Edmonton|Yellowknife|Cambridge_Bay|Inuvik|Creston|Dawson_Creek|Fort_Nelson|Whitehorse|Dawson)$/, 'Canada Mountain'],
  [/^America\/Vancouver$/, 'Canada Pacific'],
  [/^America\/(Halifax|Moncton|Glace_Bay|Goose_Bay)$/, 'Canada Atlantic'],
  [/^America\/St_Johns$/, 'Newfoundland'],
];

export function timeZoneLabel(tz: string): string {
  for (const [re, name] of ZONES) if (re.test(tz)) return name;
  return 'Other';
}

/** "iOS|Safari|Mobile" → "iPhone Safari"; every desktop is "Desktop". */
export function deviceLabel(key: string): string {
  const [os, browser, type] = key.split('|');
  if (type === 'Desktop') return 'Desktop';
  const kind = os === 'iOS' ? (type === 'Tablet' ? 'iPad' : 'iPhone') : os === 'Android' ? (type === 'Tablet' ? 'Android tablet' : 'Android') : os || 'Other';
  return browser && browser !== 'Other' ? `${kind} ${browser}` : kind;
}

/** Add up the counts that share a label, biggest first; names past `max` go into "Other". */
export function groupCounts(rows: readonly UsageCount[], label: (value: string) => string, max = 6): Array<{ label: string; count: number }> {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(label(r.value), (sums.get(label(r.value)) ?? 0) + r.count);
  const sorted = [...sums].map(([l, count]) => ({ label: l, count })).sort((a, b) => b.count - a.count);
  const named = sorted.filter((x) => x.label !== 'Other');
  let other = sorted.find((x) => x.label === 'Other')?.count ?? 0;
  const room = other > 0 || named.length > max ? max - 1 : max;
  other += named.slice(room).reduce((s, x) => s + x.count, 0);
  const keep = named.slice(0, room);
  return other > 0 ? [...keep, { label: 'Other', count: other }] : keep;
}

export const screenLabel = (v: string): string => SCREEN_GROUP[v] ?? 'Other';
export const layoutLabel = (v: string): string => LAYOUT[v] ?? 'Other';
export const backendLabel = (v: string): string => BACKEND[v] ?? 'Other';
export const micLabel = (v: string): string => MIC[v] ?? 'Other microphone problem';

/** 250 → "4m 10s"; 42 → "42s"; null → "–". */
export function shortDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '–';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

/** "Updated 12 min ago" from the server's timestamp. */
export function updatedText(iso: string, now: Date, stale: boolean): string {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  const when = min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
  return stale ? `PostHog didn’t answer; showing the numbers from ${when}.` : `Updated ${when} (every 15 min).`;
}
