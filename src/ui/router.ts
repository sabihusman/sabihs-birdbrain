export type Route =
  | { name: 'listen' }
  | { name: 'recordings' }
  | { name: 'recording'; id: string }
  | { name: 'species' }
  | { name: 'species-detail'; scientific: string }
  | { name: 'species-history'; scientific: string }
  | { name: 'map' }
  /** `section: 'account'` (#/settings/account) scrolls to and focuses the Account card. */
  | { name: 'settings'; section?: 'account' }
  | { name: 'admin' }
  | { name: 'admin-users' }
  | { name: 'help' }
  /** Sign in and Create account, each on its own page (DECISIONS.md #77). */
  | { name: 'signin' }
  /** `invite`: the token from an invite link (DECISIONS.md #80). */
  | { name: 'signup'; invite?: string }
  /** "Forgot password?" and the page the emailed link opens (DECISIONS.md #78). */
  | { name: 'forgot-password' }
  /** My account: password, sharing and friends (DECISIONS.md #79). */
  | { name: 'account' }
  | { name: 'reset-password'; token: string };

/** The `?a=b` part after a route, e.g. `#/reset-password?token=…`. */
function hashQuery(hash: string): URLSearchParams {
  const q = hash.indexOf('?');
  return new URLSearchParams(q < 0 ? '' : hash.slice(q + 1));
}

export function parseHash(hash: string): Route {
  const query = hashQuery(hash);
  const bare = hash.includes('?') ? hash.slice(0, hash.indexOf('?')) : hash;
  const path = bare.replace(/^#\/?/, '');
  const [head, ...rest] = path.split('/');
  const tail = rest.map(decodeURIComponent).join('/');
  switch (head) {
    case 'recordings':
      return tail ? { name: 'recording', id: tail } : { name: 'recordings' };
    case 'species': {
      if (!tail) return { name: 'species' };
      if (rest.length >= 2 && rest[rest.length - 1] === 'history') return { name: 'species-history', scientific: rest.slice(0, -1).map(decodeURIComponent).join('/') };
      return { name: 'species-detail', scientific: tail };
    }
    case 'map':
      return { name: 'map' };
    case 'settings':
      return rest[0] === 'account' ? { name: 'settings', section: 'account' } : { name: 'settings' };
    case 'admin':
      return rest[0] === 'users' ? { name: 'admin-users' } : { name: 'admin' };
    case 'help':
      return { name: 'help' };
    case 'signin':
      return { name: 'signin' };
    case 'signup': {
      const invite = query.get('invite');
      return invite ? { name: 'signup', invite } : { name: 'signup' };
    }
    case 'forgot-password':
      return { name: 'forgot-password' };
    case 'account':
      return { name: 'account' };
    case 'reset-password':
      return { name: 'reset-password', token: query.get('token') ?? '' };
    default:
      return { name: 'listen' };
  }
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'listen':
      return '#/listen';
    case 'recordings':
      return '#/recordings';
    case 'recording':
      return `#/recordings/${encodeURIComponent(route.id)}`;
    case 'species':
      return '#/species';
    case 'species-detail':
      return `#/species/${encodeURIComponent(route.scientific)}`;
    case 'species-history':
      return `#/species/${encodeURIComponent(route.scientific)}/history`;
    case 'map':
      return '#/map';
    case 'settings':
      return route.section === 'account' ? '#/settings/account' : '#/settings';
    case 'admin':
      return '#/admin';
    case 'admin-users':
      return '#/admin/users';
    case 'help':
      return '#/help';
    case 'signin':
      return '#/signin';
    case 'signup':
      return route.invite ? `#/signup?invite=${encodeURIComponent(route.invite)}` : '#/signup';
    case 'forgot-password':
      return '#/forgot-password';
    case 'account':
      return '#/account';
    case 'reset-password':
      return route.token ? `#/reset-password?token=${encodeURIComponent(route.token)}` : '#/reset-password';
  }
}

export function navigate(route: Route): void {
  location.hash = hrefFor(route);
}

export function speciesHref(scientific: string): string {
  return hrefFor({ name: 'species-detail', scientific });
}

/**
 * "‹ Back" on the account pages (DECISIONS.md #106): back to the page the person came from inside the app, or to
 * `fallback` when they arrived straight on this page (an emailed link, a bookmark), so Back never leaves the app.
 */
let movedInApp = false;
export function noteInAppNavigation(): void {
  movedInApp = true;
}
export function goBack(fallback: string, h: Pick<History, 'back'> = history, loc: Pick<Location, 'hash'> = location): void {
  if (movedInApp) h.back();
  else loc.hash = fallback;
}
/** Tests only. */
export function resetInAppNavigationForTest(): void {
  movedInApp = false;
}
