import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/app/settings';
import type { SessionStats } from '../src/app/controller';
import type { ModelStatus } from '../src/model/worker-client';
import { Emitter } from '../src/shared/emitter';
import {
  browserSaysNo,
  buildPayload,
  cleanProperties,
  COOKIELESS_ID,
  describeDevice,
  PAGES,
  referringDomain,
  UsageCounts,
  usageConfig,
  type PageEnv,
  type UsageEvent,
} from '../src/app/usage-counts';
import { audienceFor, pageOf, wireUsageCounts, type ControllerLike } from '../src/app/usage-wiring';
import { USAGE_NEVER_SENT, usageHint } from '../src/ui/components/privacy-card';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.1; rv:132.0) Gecko/20100101 Firefox/132.0';

const ENV: PageEnv = { origin: 'https://sabihs-birdbrain.vercel.app', host: 'sabihs-birdbrain.vercel.app', userAgent: IPHONE_SAFARI, maxTouchPoints: 5, timeZone: 'America/Chicago', viewportWidth: 393, referrer: '' };
const CONFIG = { key: 'phc_test', host: 'https://us.i.posthog.com' };
const NOW = new Date('2026-11-10T18:00:00Z');

function counter(o: { enabled?: boolean; blocked?: boolean; configured?: boolean; automated?: boolean } = {}) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const usage = new UsageCounts(o.configured === false ? null : CONFIG, {
    enabled: () => o.enabled ?? true,
    audience: () => 'member',
    browserBlocked: () => o.blocked ?? false,
    automated: () => o.automated ?? false,
    env: () => ENV,
    now: () => NOW,
    send: (url, body) => sent.push({ url, body: JSON.parse(body) as Record<string, unknown> }),
  });
  return { usage, sent };
}

describe('usage counts: when anything is sent', () => {
  it('needs a key in the build; the host defaults to PostHog US', () => {
    expect(usageConfig({})).toBeNull();
    expect(usageConfig({ VITE_POSTHOG_KEY: '  ' })).toBeNull();
    expect(usageConfig({ VITE_POSTHOG_KEY: 'phc_x' })).toEqual({ key: 'phc_x', host: 'https://us.i.posthog.com' });
    expect(usageConfig({ VITE_POSTHOG_KEY: 'phc_x', VITE_POSTHOG_HOST: 'https://eu.i.posthog.com/' })).toEqual({ key: 'phc_x', host: 'https://eu.i.posthog.com' });
  });

  it('sends nothing without a key, with the switch off, when the browser asks not to be tracked, or under automation', () => {
    for (const o of [{ configured: false }, { enabled: false }, { blocked: true }, { automated: true }]) {
      const { usage, sent } = counter(o);
      usage.pageview('listen');
      usage.track({ event: 'listen_started', layout: 'focus' });
      expect(sent).toEqual([]);
      expect(usage.active).toBe(false);
    }
    expect(browserSaysNo({ globalPrivacyControl: true })).toBe(true);
    expect(browserSaysNo({ doNotTrack: '1' })).toBe(true);
    expect(browserSaysNo({ doNotTrack: '0' })).toBe(false);
    expect(browserSaysNo(undefined)).toBe(false);
  });

  it('posts one cookieless event to the capture endpoint', () => {
    const { usage, sent } = counter();
    usage.pageview('map');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://us.i.posthog.com/i/v0/e/');
    const body = sent[0].body as { api_key: string; event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> };
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('$pageview');
    // PostHog's cookieless mode swaps this sentinel for its daily hash; nothing on the phone holds an id.
    expect(body.distinct_id).toBe(COOKIELESS_ID);
    expect(body.timestamp).toBe('2026-11-10T18:00:00.000Z');
    expect(body.properties).toMatchObject({
      page: 'map',
      $cookieless_mode: true,
      $process_person_profile: false,
      $raw_user_agent: IPHONE_SAFARI,
      $host: 'sabihs-birdbrain.vercel.app',
      $current_url: 'https://sabihs-birdbrain.vercel.app/#/map',
      $pathname: '/map',
      $os: 'iOS',
      $browser: 'Safari',
      $device_type: 'Mobile',
      $viewport_width: 390,
      $timezone: 'America/Chicago',
      $referring_domain: '$direct',
      audience: 'member',
    });
  });

  it('later events carry the page they happened on', () => {
    const { usage, sent } = counter();
    usage.pageview('recordings');
    usage.track({ event: 'recording_saved', seconds: 12.4 });
    expect(sent[1].body.properties).toMatchObject({ $current_url: 'https://sabihs-birdbrain.vercel.app/#/recordings', seconds: 12.4 });
    expect((sent[1].body.properties as Record<string, unknown>).$referring_domain).toBeUndefined();
  });
});

describe('usage counts: never sent', () => {
  it('drops any field outside the fixed list, and any value outside its fixed values', () => {
    const sneaky = {
      event: 'listen_stopped',
      layout: 'focus',
      seconds: 250.6,
      birds: 3,
      windows: 120,
      skipped: 2,
      // None of these may survive.
      species: 'Turdus migratorius',
      scientific: 'Cardinalis cardinalis',
      lat: 41.67,
      lon: -93.69,
      email: 'someone@example.com',
      question: 'Why does it sing at night?',
      audio: [0.1, 0.2],
    } as unknown as UsageEvent;
    expect(cleanProperties(sneaky)).toEqual({ layout: 'focus', seconds: 251, birds: 3, windows: 120, skipped: 2 });
    expect(cleanProperties({ event: 'layout_changed', layout: 'Turdus migratorius' } as unknown as UsageEvent)).toEqual({});
    expect(cleanProperties({ event: '$pageview', page: 'species-detail/Turdus migratorius' } as unknown as UsageEvent)).toEqual({});
    expect(cleanProperties({ event: 'made_up' } as unknown as UsageEvent)).toBeNull();
  });

  it('the whole body holds none of them, and the address is the route name only', () => {
    const { usage, sent } = counter();
    usage.pageview('species-detail');
    usage.track({ event: 'listen_stopped', layout: 'focus', seconds: 60, birds: 2, windows: 30, skipped: 0, species: 'Turdus migratorius', lat: 41.67, email: 'someone@example.com' } as unknown as UsageEvent);
    const text = JSON.stringify(sent);
    for (const bad of ['Turdus', 'Cardinalis', '41.67', 'example.com', 'question', 'token', 'invite']) expect(text).not.toContain(bad);
    expect(sent[0].body.properties).toMatchObject({ $current_url: 'https://sabihs-birdbrain.vercel.app/#/species-detail', $pathname: '/species-detail' });
  });

  it('pages are route names: a reset link or invite token cannot become one', () => {
    expect(PAGES).toContain('reset-password');
    expect(pageOf('reset-password')).toBe('reset-password');
    expect(pageOf('reset-password?token=abc')).toBeNull();
    const p = buildPayload({ config: CONFIG, event: { event: '$pageview', page: 'signup' }, page: 'signup', audience: 'signed-out', env: { ...ENV, referrer: 'https://mail.example.org/inbox?x=1' }, now: NOW });
    expect(p?.properties.$current_url).toBe('https://sabihs-birdbrain.vercel.app/#/signup');
    expect(p?.properties.$referring_domain).toBe('mail.example.org');
  });

  it('Settings › Privacy says it in plain words', () => {
    expect(USAGE_NEVER_SENT).toBe('Never sent: audio, GPS position, bird names, your email or what members ask.');
    expect(usageHint({ configured: false, blockedByBrowser: false })).toMatch(/nothing is sent/);
    expect(usageHint({ configured: true, blockedByBrowser: true })).toMatch(/browser asks websites not to track/);
    expect(usageHint({ configured: true, blockedByBrowser: false })).toBe('Helps Sabih see what gets used and what breaks.');
  });
});

describe('usage counts: automation', () => {
  it('reads navigator.webdriver when no override is given', () => {
    const nav = globalThis.navigator as Navigator & { webdriver?: boolean };
    const had = Object.getOwnPropertyDescriptor(nav, 'webdriver');
    const make = () => new UsageCounts(CONFIG, { enabled: () => true, audience: () => 'member', browserBlocked: () => false, env: () => ENV, send: () => undefined });
    try {
      Object.defineProperty(nav, 'webdriver', { configurable: true, get: () => true });
      expect(make().automated).toBe(true);
      expect(make().active).toBe(false);
      Object.defineProperty(nav, 'webdriver', { configurable: true, get: () => false });
      expect(make().automated).toBe(false);
      expect(make().active).toBe(true);
    } finally {
      if (had) Object.defineProperty(nav, 'webdriver', had);
      else delete (nav as unknown as Record<string, unknown>).webdriver;
    }
  });
});

describe('usage counts: device names', () => {
  it('names the common phones and browsers', () => {
    expect(describeDevice(IPHONE_SAFARI, 5)).toEqual({ os: 'iOS', browser: 'Safari', deviceType: 'Mobile' });
    expect(describeDevice(IPHONE_CHROME, 5)).toEqual({ os: 'iOS', browser: 'Chrome', deviceType: 'Mobile' });
    expect(describeDevice(ANDROID_CHROME, 5)).toEqual({ os: 'Android', browser: 'Chrome', deviceType: 'Mobile' });
    expect(describeDevice(IPAD_AS_MAC, 5)).toEqual({ os: 'iOS', browser: 'Safari', deviceType: 'Tablet' });
    expect(describeDevice(IPAD_AS_MAC, 0)).toEqual({ os: 'macOS', browser: 'Safari', deviceType: 'Desktop' });
    expect(describeDevice(WINDOWS_EDGE, 0)).toEqual({ os: 'Windows', browser: 'Edge', deviceType: 'Desktop' });
    expect(describeDevice(MAC_FIREFOX, 0)).toEqual({ os: 'macOS', browser: 'Firefox', deviceType: 'Desktop' });
  });

  it('keeps only the host of where a visit came from', () => {
    expect(referringDomain('', 'sabihs-birdbrain.vercel.app')).toBe('$direct');
    expect(referringDomain('https://sabihs-birdbrain.vercel.app/#/map', 'sabihs-birdbrain.vercel.app')).toBe('$direct');
    expect(referringDomain('https://www.google.com/search?q=bird+app', 'sabihs-birdbrain.vercel.app')).toBe('www.google.com');
  });
});

describe('usage counts: from the controller', () => {
  type Events = { stats: SessionStats; model: ModelStatus; notice: unknown; 'recording-saved': { durationSec: number } };
  function fake() {
    const em = new Emitter<Events>();
    const settingsEm = new Emitter<{ change: Settings }>();
    let current: Settings = { ...DEFAULT_SETTINGS, listenLayout: 'focus' };
    const state = { hits: [] as unknown[], micError: null as null | { kind: 'denied' }, failure: null as null | { unsupported: boolean } };
    const controller = {
      on: em.on.bind(em),
      getSessionHits: () => state.hits,
      getModelFailure: () => state.failure,
      getMicError: () => state.micError,
      modelFromCache: true,
      settings: {
        get: () => current,
        on: settingsEm.on.bind(settingsEm),
        update: (p: Partial<Settings>) => {
          current = { ...current, ...p };
          settingsEm.emit('change', current);
        },
      },
    };
    const { usage, sent } = counter();
    wireUsageCounts(controller as unknown as ControllerLike, usage, () => current.listenLayout);
    const stats = (s: Partial<SessionStats>) => em.emit('stats', { listening: false, paused: false, startedAt: null, elapsedSec: 0, windows: 0, dropped: 0, lastInferMs: 0, contextSampleRate: 48000, ...s });
    return { em, controller, state, sent, stats, names: () => sent.map((s) => s.body.event) };
  }
  const model = (s: Partial<ModelStatus>): ModelStatus => ({ state: 'idle', phase: null, progress: 0, loadedBytes: 0, totalBytes: 0, message: '', backend: null, loadMs: 0, warmupMs: 0, ...s });

  it('counts a listen once, through a BirdAmp pause, with its length and number of birds', () => {
    const f = fake();
    f.stats({ listening: true });
    f.stats({ listening: true, elapsedSec: 1 });
    f.stats({ listening: false, paused: true, elapsedSec: 30 });
    f.stats({ listening: true, elapsedSec: 30 });
    f.state.hits = [{}, {}, {}];
    f.stats({ listening: false, elapsedSec: 95.4, windows: 64, dropped: 1 });
    expect(f.names()).toEqual(['listen_started', 'listen_stopped']);
    expect(f.sent[1].body.properties).toMatchObject({ layout: 'focus', seconds: 95, birds: 3, windows: 64, skipped: 1 });
  });

  it('counts the model load once with its speed, and a failure', () => {
    const f = fake();
    f.em.emit('model', model({ state: 'loading' }));
    f.em.emit('model', model({ state: 'ready', backend: 'webgl', loadMs: 1200, warmupMs: 400 }));
    f.em.emit('model', model({ state: 'ready', backend: 'webgl', loadMs: 1200, warmupMs: 400 }));
    f.em.emit('model', model({ state: 'error' }));
    expect(f.names()).toEqual(['model_loaded', 'model_failed']);
    expect(f.sent[0].body.properties).toMatchObject({ backend: 'webgl', load_seconds: 1.6, from_cache: true });
    expect(f.sent[1].body.properties).toMatchObject({ unsupported: false });
  });

  it('says once when the browser cannot run the model at all', () => {
    const f = fake();
    f.state.failure = { unsupported: true };
    f.em.emit('model', model({ state: 'idle' }));
    f.em.emit('model', model({ state: 'idle' }));
    expect(f.names()).toEqual(['model_failed']);
    expect(f.sent[0].body.properties).toMatchObject({ unsupported: true });
  });

  it('counts a microphone problem, a layout change and a saved recording', () => {
    const f = fake();
    f.state.micError = { kind: 'denied' };
    f.em.emit('notice', {});
    f.em.emit('notice', {});
    f.controller.settings.update({ listenLayout: 'dock' });
    f.controller.settings.update({ threshold: 0.8 });
    f.em.emit('recording-saved', { durationSec: 42 });
    expect(f.names()).toEqual(['mic_problem', 'layout_changed', 'recording_saved']);
    expect(f.sent.map((s) => s.body.properties)).toMatchObject([{ problem: 'denied' }, { layout: 'dock' }, { seconds: 42 }]);
  });

  it('marks the admin apart, so Sabih can leave his own use out', () => {
    expect(audienceFor(null)).toBe('signed-out');
    expect(audienceFor({ role: 'admin', status: 'approved' } as never)).toBe('admin');
    expect(audienceFor({ role: 'user', status: 'approved' } as never)).toBe('member');
    expect(audienceFor({ role: 'user', status: 'pending' } as never)).toBe('pending');
    expect(audienceFor({ role: 'user', status: 'disabled' } as never)).toBe('signed-out');
  });
});
