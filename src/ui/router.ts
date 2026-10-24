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
  | { name: 'signup' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
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
    case 'signup':
      return { name: 'signup' };
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
      return '#/signup';
  }
}

export function navigate(route: Route): void {
  location.hash = hrefFor(route);
}

export function speciesHref(scientific: string): string {
  return hrefFor({ name: 'species-detail', scientific });
}
