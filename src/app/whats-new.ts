import type { AuthUser } from '../api/client';
import { memberAccess } from './access';
import type { ListenLayout } from './settings';

/**
 * "What's new" (DECISIONS.md #112): one quiet strip on Listen that opens a few swipe cards, once per person, for
 * as long as the announcement runs; afterwards it stays readable in Settings › What's new. Sabih chose B + C
 * (strip, then cards), "Don't show me this again" turns all future pop-ups off (option 1), and a brand-new visitor
 * sees the strip right after the welcome screen (option 2).
 *
 * The rules that keep people from seeing the same thing twice:
 * - an announcement counts as seen the moment its strip appears, not when it is closed;
 * - seen ids live on the phone and, when signed in, on the account (`/v1/me/whats-new`);
 * - at most one strip per visit, the newest unseen one; never while listening;
 * - after its last day an announcement never pops up again, it is only listed.
 */
export type Audience = 'signed-out' | 'pending' | 'member';

export interface WhatsNewCard {
  title: string;
  text: string;
  /** What the card shows above the dots. */
  art: 'birdamp' | 'ask' | 'map';
}

export interface WhatsNewEntry {
  id: string;
  /** Local calendar day it starts showing (YYYY-MM-DD) and the day after it stops (exclusive). */
  from: string;
  until?: string;
  kind: 'new' | 'fixed' | 'coming';
  /** The line in Settings › What's new. */
  title: string;
  text: string;
  /** The strip's words, per audience; no strip for an audience missing here. */
  strip?: Partial<Record<Audience, string>>;
  cards?: Partial<Record<Audience, WhatsNewCard[]>>;
  /** Not shown to someone already using what it announces. */
  skipFor?: (layout: ListenLayout) => boolean;
}

/** Newest first. Wording from the What's new mockups Sabih approved (Nov 1–2). */
export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    id: '2026-11-birdamp',
    from: '2026-11-01',
    until: '2026-12-01',
    kind: 'new',
    title: 'BirdAmp',
    text: 'A Winamp-style Listen screen for members: live LCD, spectrogram and your birds as a playlist.',
    strip: {
      'signed-out': 'New: BirdAmp, a Winamp-style Listen screen',
      pending: 'New: BirdAmp, a Winamp-style Listen screen',
      member: 'New: BirdAmp is here',
    },
    cards: {
      'signed-out': [
        { title: 'Meet BirdAmp', text: 'A Winamp-style Listen screen: live LCD, spectrogram and your birds as a playlist. For members.', art: 'birdamp' },
        { title: 'Ask about any bird you hear', text: 'Members can ask a question on a sighting; AI answers it from the bird’s Wikipedia article and other sources.', art: 'ask' },
        { title: 'Your birds, on a map', text: 'Where you heard each bird, its best clip, and a list you can share with friends.', art: 'map' },
      ],
      pending: [{ title: 'BirdAmp is on its way', text: 'A Winamp-style Listen screen. It unlocks for you once Sabih approves your account.', art: 'birdamp' }],
      member: [{ title: 'BirdAmp is here', text: 'A Winamp-style Listen screen. Try it now; you can switch back any time from the layout bubble or Settings.', art: 'birdamp' }],
    },
    skipFor: (layout) => layout === 'birdamp',
  },
  {
    id: '2026-11-see-the-sound',
    from: '2026-11-01',
    kind: 'fixed',
    title: 'See the sound fits on the screen',
    text: 'The live views’ captions moved behind ⓘ, and the 1–7 steps moved to Help, so all four pictures fit on a phone.',
  },
  {
    id: '2026-11-names',
    from: '2026-11-01',
    kind: 'fixed',
    title: 'Bird names show correctly',
    text: 'Bird names and photo credits with apostrophes no longer show stray characters, and Listen’s cards no longer flicker while listening.',
  },
];

export function audienceOf(user: AuthUser | null | undefined): Audience | null {
  const a = memberAccess(user);
  return a === 'blocked' ? null : a;
}

/** Local calendar day as YYYY-MM-DD. */
export function localDay(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

export function isRunning(e: WhatsNewEntry, now: Date): boolean {
  const day = localDay(now);
  return day >= e.from && (e.until === undefined || day < e.until);
}

export interface WhatsNewState {
  seen: string[];
  muted: boolean;
  /** The newest listed entry when Settings › What's new was last opened (the dot goes until then). */
  opened: string | null;
}

export const WHATS_NEW_KEY = 'birdbrain.whatsnew.v1';
export const EMPTY_STATE: WhatsNewState = { seen: [], muted: false, opened: null };

export function parseState(raw: string | null): WhatsNewState {
  if (!raw) return { ...EMPTY_STATE };
  try {
    const v = JSON.parse(raw) as Partial<WhatsNewState>;
    return {
      seen: Array.isArray(v.seen) ? v.seen.filter((x): x is string => typeof x === 'string') : [],
      muted: v.muted === true,
      opened: typeof v.opened === 'string' ? v.opened : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** The strip to show now, or null: the newest running announcement for this audience that is not seen, unless muted. */
export function pickAnnouncement(o: { entries?: readonly WhatsNewEntry[]; now: Date; audience: Audience | null; state: WhatsNewState; layout: ListenLayout }): WhatsNewEntry | null {
  if (!o.audience || o.state.muted) return null;
  for (const e of o.entries ?? WHATS_NEW) {
    if (!e.strip?.[o.audience] || !e.cards?.[o.audience]?.length) continue;
    if (!isRunning(e, o.now)) continue;
    if (o.state.seen.includes(e.id)) continue;
    if (e.skipFor?.(o.layout)) continue;
    return e;
  }
  return null;
}

/** What Settings › What's new lists: everything that has started, newest first. */
export function listed(now: Date, entries: readonly WhatsNewEntry[] = WHATS_NEW): WhatsNewEntry[] {
  const day = localDay(now);
  return entries.filter((e) => e.from <= day);
}

/** The dot on the Settings row: something listed since the page was last opened. */
export function hasDot(state: WhatsNewState, now: Date, entries: readonly WhatsNewEntry[] = WHATS_NEW): boolean {
  const newest = listed(now, entries)[0];
  return !!newest && state.opened !== newest.id;
}

/** Phone and account copies combined: every seen id from either; off if either says off. */
export function mergeStates(local: WhatsNewState, remote: { seen: string[]; muted: boolean }): WhatsNewState {
  return { seen: [...new Set([...local.seen, ...remote.seen])], muted: local.muted || remote.muted, opened: local.opened };
}

interface AccountApi {
  readonly user: AuthUser | null;
  getWhatsNew(): Promise<{ seen: string[]; muted: boolean }>;
  postWhatsNew(patch: { seen?: string[]; muted?: boolean }): Promise<{ seen: string[]; muted: boolean }>;
}

/** The phone's record, kept in step with the account's when signed in. Failures to reach the server change nothing. */
export class WhatsNewService {
  private state: WhatsNewState;
  private syncing: Promise<void> | null = null;
  private syncedFor: string | null = null;
  /** One strip per visit (page load). */
  shownThisVisit = false;

  constructor(
    private readonly api: AccountApi,
    private readonly storage: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
  ) {
    this.state = this.load();
  }

  private load(): WhatsNewState {
    try {
      return parseState(this.storage?.getItem(WHATS_NEW_KEY) ?? null);
    } catch {
      return { ...EMPTY_STATE };
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(WHATS_NEW_KEY, JSON.stringify(this.state));
    } catch {
      /* private mode: lasts for this visit */
    }
  }

  get(): WhatsNewState {
    return this.state;
  }

  /** Bring in the account's copy once per signed-in user, waiting at most `timeoutMs` so Listen never stalls. */
  ready(timeoutMs = 1500): Promise<void> {
    const user = this.api.user;
    if (!user || this.syncedFor === user.id) return Promise.resolve();
    this.syncing ??= (async () => {
      try {
        const remote = await this.api.getWhatsNew();
        this.state = mergeStates(this.load(), remote);
        this.save();
        this.syncedFor = user.id;
        if (remote.seen.length !== this.state.seen.length || remote.muted !== this.state.muted) void this.api.postWhatsNew({ seen: this.state.seen, muted: this.state.muted }).catch(() => undefined);
      } catch {
        /* offline or an old server: the phone's copy stands */
      } finally {
        this.syncing = null;
      }
    })();
    return Promise.race([this.syncing, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  pick(audience: Audience | null, layout: ListenLayout, now = new Date()): WhatsNewEntry | null {
    if (this.shownThisVisit) return null;
    return pickAnnouncement({ now, audience, state: this.state, layout });
  }

  markSeen(id: string): void {
    this.shownThisVisit = true;
    if (!this.state.seen.includes(id)) {
      this.state = { ...this.state, seen: [...this.state.seen, id] };
      this.save();
    }
    if (this.api.user) void this.api.postWhatsNew({ seen: [id] }).catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    this.state = { ...this.state, muted };
    this.save();
    if (this.api.user) void this.api.postWhatsNew({ muted }).catch(() => undefined);
  }

  markOpened(now = new Date()): void {
    const newest = listed(now)[0];
    if (!newest || this.state.opened === newest.id) return;
    this.state = { ...this.state, opened: newest.id };
    this.save();
  }
}
