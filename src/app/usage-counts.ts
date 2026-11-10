import type { ListenLayout } from './settings';

/**
 * Anonymous usage counts (DECISIONS.md #120, Sabih's "Version 2, don't ask"): a few events go to PostHog in its
 * cookieless mode, with no ID kept on the phone and nothing written to storage for them. PostHog's server turns
 * the IP address, user agent and host into a hash with a salt that changes every day, then drops the IP and the
 * user agent, so a phone counts once per day and is never recognised the next day.
 *
 * This file is the whole client: no PostHog library, no autocapture, no recordings. Every event has a fixed list
 * of properties and every string property a fixed list of values (`SCHEMA`), checked again just before sending,
 * so audio, GPS positions, bird names, emails, member questions, record ids and link tokens cannot reach it even
 * by mistake. Pages are sent by route name only (`#/species-detail`, never the species).
 *
 * Off when the build has no key (`VITE_POSTHOG_KEY`), when the Settings › Privacy switch is off, and when the
 * browser sends Global Privacy Control or Do Not Track.
 */

/** Route names, the only part of the address that is sent. */
export const PAGES = [
  'listen',
  'recordings',
  'recording',
  'species',
  'species-detail',
  'species-history',
  'map',
  'settings',
  'admin',
  'admin-users',
  'help',
  'whats-new',
  'signin',
  'signup',
  'forgot-password',
  'account',
  'reset-password',
] as const;
export type PageName = (typeof PAGES)[number];

const LAYOUT_VALUES: readonly ListenLayout[] = ['consolidated', 'dock', 'focus', 'birdamp'];
const BACKENDS = ['webgl', 'wasm', 'cpu'] as const;
const MIC_PROBLEMS = ['denied', 'no-mic', 'insecure', 'unsupported', 'busy', 'other'] as const;

export type UsageEvent =
  | { event: '$pageview'; page: PageName }
  | { event: 'listen_started'; layout: ListenLayout }
  | { event: 'listen_stopped'; layout: ListenLayout; seconds: number; birds: number; windows: number; skipped: number }
  | { event: 'model_loaded'; backend: (typeof BACKENDS)[number]; load_seconds: number; from_cache: boolean }
  | { event: 'model_failed'; unsupported: boolean }
  | { event: 'mic_problem'; problem: (typeof MIC_PROBLEMS)[number] }
  | { event: 'layout_changed'; layout: ListenLayout }
  | { event: 'recording_saved'; seconds: number };

type Kind = 'count' | 'seconds' | 'boolean' | readonly string[];
/** What each event may carry. Anything else is dropped before sending. */
export const SCHEMA: Record<UsageEvent['event'], Record<string, Kind>> = {
  $pageview: { page: PAGES },
  listen_started: { layout: LAYOUT_VALUES },
  listen_stopped: { layout: LAYOUT_VALUES, seconds: 'seconds', birds: 'count', windows: 'count', skipped: 'count' },
  model_loaded: { backend: BACKENDS, load_seconds: 'seconds', from_cache: 'boolean' },
  model_failed: { unsupported: 'boolean' },
  mic_problem: { problem: MIC_PROBLEMS },
  layout_changed: { layout: LAYOUT_VALUES },
  recording_saved: { seconds: 'seconds' },
};

export type Audience = 'signed-out' | 'pending' | 'member' | 'admin';
const AUDIENCES: readonly Audience[] = ['signed-out', 'pending', 'member', 'admin'];

/** Only the event's own fields, each of an allowed kind; null when the event is unknown. */
export function cleanProperties(e: UsageEvent): Record<string, string | number | boolean> | null {
  const schema = SCHEMA[e.event];
  if (!schema) return null;
  const out: Record<string, string | number | boolean> = {};
  const values = e as unknown as Record<string, unknown>;
  for (const [key, kind] of Object.entries(schema)) {
    const v = values[key];
    if (kind === 'boolean') {
      if (typeof v === 'boolean') out[key] = v;
    } else if (kind === 'count') {
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.max(0, Math.min(1_000_000, Math.round(v)));
    } else if (kind === 'seconds') {
      // Tenths below a minute (model load times), whole seconds above.
      if (typeof v === 'number' && Number.isFinite(v)) {
        const s = Math.max(0, Math.min(86_400, v));
        out[key] = s < 60 ? Math.round(s * 10) / 10 : Math.round(s);
      }
    } else if (typeof v === 'string' && kind.includes(v)) out[key] = v;
  }
  return out;
}

export interface DeviceInfo {
  os: 'iOS' | 'Android' | 'Windows' | 'macOS' | 'ChromeOS' | 'Linux' | 'Other';
  browser: 'Safari' | 'Chrome' | 'Firefox' | 'Edge' | 'Samsung Internet' | 'Other';
  deviceType: 'Mobile' | 'Tablet' | 'Desktop';
}

/** Coarse names from the user agent, as PostHog's own library would add them (the raw string is dropped by PostHog). */
export function describeDevice(ua: string, maxTouchPoints = 0): DeviceInfo {
  const iPadAsMac = /Macintosh/.test(ua) && maxTouchPoints > 1;
  const os: DeviceInfo['os'] = /iPhone|iPad|iPod/.test(ua) || iPadAsMac ? 'iOS' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser: DeviceInfo['browser'] = /EdgiOS|EdgA|Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
      ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(ua)
        ? 'Firefox'
        : /CriOS|Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari/.test(ua) && /Version\//.test(ua)
            ? 'Safari'
            : 'Other';
  const deviceType: DeviceInfo['deviceType'] = /iPad/.test(ua) || iPadAsMac || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet' : /iPhone|iPod|Mobile/.test(ua) ? 'Mobile' : 'Desktop';
  return { os, browser, deviceType };
}

export interface UsageConfig {
  /** PostHog project token (phc_…): public by design, it is in every visitor's page. */
  key: string;
  /** Ingestion host, e.g. https://us.i.posthog.com. Must also be in vercel.json's connect-src. */
  host: string;
}

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export function usageConfig(env: { VITE_POSTHOG_KEY?: string; VITE_POSTHOG_HOST?: string }): UsageConfig | null {
  const key = env.VITE_POSTHOG_KEY?.trim();
  if (!key) return null;
  return { key, host: (env.VITE_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, '') };
}

/** The browser asks sites not to track it: Global Privacy Control, or the older Do Not Track. */
export function browserSaysNo(nav: { globalPrivacyControl?: boolean; doNotTrack?: string | null } | undefined): boolean {
  return nav?.globalPrivacyControl === true || nav?.doNotTrack === '1';
}

/** What the page knows about itself; read fresh for each event. */
export interface PageEnv {
  origin: string;
  host: string;
  userAgent: string;
  maxTouchPoints: number;
  timeZone: string | undefined;
  viewportWidth: number;
  referrer: string;
}

export function readPageEnv(): PageEnv {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  return {
    origin: location.origin,
    host: location.host,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    timeZone,
    viewportWidth: window.innerWidth,
    referrer: document.referrer,
  };
}

/** The sentinel PostHog's cookieless mode replaces with its daily hash. */
export const COOKIELESS_ID = '$posthog_cookieless';

export interface CapturePayload {
  api_key: string;
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, string | number | boolean>;
}

/** The exact body sent for one event. Pure, so the tests can read every field. */
export function buildPayload(o: { config: UsageConfig; event: UsageEvent; page: PageName; audience: Audience; env: PageEnv; now: Date }): CapturePayload | null {
  const own = cleanProperties(o.event);
  if (!own) return null;
  const page = PAGES.includes(o.page) ? o.page : 'listen';
  const device = describeDevice(o.env.userAgent, o.env.maxTouchPoints);
  const properties: Record<string, string | number | boolean> = {
    ...own,
    // Cookieless mode: PostHog hashes these (with the IP) into today's anonymous id, then deletes the user agent.
    $cookieless_mode: true,
    $process_person_profile: false,
    $raw_user_agent: o.env.userAgent.slice(0, 1000),
    $host: o.env.host,
    $lib: 'birdbrain-web',
    $current_url: `${o.env.origin}/#/${page}`,
    $pathname: `/${page}`,
    $os: device.os,
    $browser: device.browser,
    $device_type: device.deviceType,
    $viewport_width: Math.round(o.env.viewportWidth / 10) * 10,
    audience: AUDIENCES.includes(o.audience) ? o.audience : 'signed-out',
  };
  if (o.env.timeZone) properties.$timezone = o.env.timeZone;
  if (o.event.event === '$pageview') properties.$referring_domain = referringDomain(o.env.referrer, o.env.host);
  return { api_key: o.config.key, event: o.event.event, distinct_id: COOKIELESS_ID, timestamp: o.now.toISOString(), properties };
}

/** Where the visit came from, as a bare host name ("$direct" for none or for the app itself); never the full address. */
export function referringDomain(referrer: string, ownHost: string): string {
  try {
    const host = new URL(referrer).hostname;
    return host && host !== ownHost.replace(/:\d+$/, '') ? host : '$direct';
  } catch {
    return '$direct';
  }
}

export type Sender = (url: string, body: string) => void;

const fetchSender: Sender = (url, body) => {
  void fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json' } }).catch(() => undefined);
};

export class UsageCounts {
  private page: PageName = 'listen';

  constructor(
    private readonly config: UsageConfig | null,
    private readonly opts: {
      /** The Settings › Privacy switch. */
      enabled: () => boolean;
      audience: () => Audience;
      browserBlocked?: () => boolean;
      env?: () => PageEnv;
      send?: Sender;
      now?: () => Date;
    },
  ) {}

  /** A key is built in: the switch means something. */
  get configured(): boolean {
    return this.config !== null;
  }

  /** The browser's own "don't track me" setting wins over the switch. */
  get blockedByBrowser(): boolean {
    return (this.opts.browserBlocked ?? (() => browserSaysNo(typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { globalPrivacyControl?: boolean }))))();
  }

  get active(): boolean {
    return this.configured && !this.blockedByBrowser && this.opts.enabled();
  }

  /** Remember the page for later events; sends a page view. */
  pageview(page: PageName): void {
    this.page = page;
    this.track({ event: '$pageview', page });
  }

  track(event: UsageEvent): void {
    if (!this.config || !this.active) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      const payload = buildPayload({ config: this.config, event, page: this.page, audience: this.opts.audience(), env: (this.opts.env ?? readPageEnv)(), now: (this.opts.now ?? (() => new Date()))() });
      if (payload) (this.opts.send ?? fetchSender)(`${this.config.host}/i/v0/e/`, JSON.stringify(payload));
    } catch {
      /* counting never gets in the way */
    }
  }
}
