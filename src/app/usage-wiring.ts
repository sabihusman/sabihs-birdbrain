import type { AuthUser } from '../api/client';
import type { ModelStatus } from '../model/worker-client';
import type { AppController, SessionStats } from './controller';
import type { ListenLayout } from './settings';
import { memberAccess } from './access';
import { PAGES, type Audience, type PageName, type UsageCounts } from './usage-counts';

/**
 * Turns the controller's own events into the few usage counts (DECISIONS.md #120). Nothing here reads a
 * detection, a position or a name: only states, durations and totals.
 */
export function audienceFor(user: AuthUser | null | undefined): Audience {
  if (user?.role === 'admin') return 'admin';
  const a = memberAccess(user);
  return a === 'member' || a === 'pending' ? a : 'signed-out';
}

export function pageOf(routeName: string): PageName | null {
  return (PAGES as readonly string[]).includes(routeName) ? (routeName as PageName) : null;
}

/** The parts of the controller this reads; the tests pass a small fake. */
export type ControllerLike = Pick<AppController, 'on' | 'getSessionHits' | 'getModelFailure' | 'getMicError' | 'modelFromCache' | 'settings'>;

export function wireUsageCounts(controller: ControllerLike, usage: UsageCounts, layoutNow: () => ListenLayout): () => void {
  let prev: SessionStats | null = null;
  let modelState: ModelStatus['state'] = 'idle';
  let unsupportedSent = false;
  let lastMicError: unknown = null;
  let layout = controller.settings.get().listenLayout;
  const offs = [
    controller.on('stats', (s) => {
      const was = prev;
      prev = s;
      const wasOn = !!was && (was.listening || was.paused);
      // A fresh start, not BirdAmp's resume after Pause.
      if (s.listening && !wasOn) usage.track({ event: 'listen_started', layout: layoutNow() });
      else if (wasOn && !s.listening && !s.paused) usage.track({ event: 'listen_stopped', layout: layoutNow(), seconds: s.elapsedSec, birds: controller.getSessionHits().length, windows: s.windows, skipped: s.dropped });
    }),
    controller.on('model', (m) => {
      // A browser that cannot run the model at all never starts loading: the controller says so with a model event.
      if (controller.getModelFailure()?.unsupported && !unsupportedSent) {
        unsupportedSent = true;
        usage.track({ event: 'model_failed', unsupported: true });
      }
      const before = modelState;
      modelState = m.state;
      if (m.state === before) return;
      if (m.state === 'ready' && m.backend) usage.track({ event: 'model_loaded', backend: m.backend, load_seconds: (m.loadMs + m.warmupMs) / 1000, from_cache: controller.modelFromCache });
      else if (m.state === 'error') usage.track({ event: 'model_failed', unsupported: false });
    }),
    controller.on('notice', () => {
      const e = controller.getMicError();
      if (e && e !== lastMicError) usage.track({ event: 'mic_problem', problem: e.kind });
      lastMicError = e;
    }),
    controller.on('recording-saved', (r) => usage.track({ event: 'recording_saved', seconds: r.durationSec })),
    controller.settings.on('change', (s) => {
      if (s.listenLayout !== layout) usage.track({ event: 'layout_changed', layout: s.listenLayout });
      layout = s.listenLayout;
    }),
  ];
  return () => offs.forEach((off) => off());
}
