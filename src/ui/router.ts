export type Route =
  | { name: 'listen' }
  | { name: 'recordings' }
  | { name: 'recording'; id: string }
  | { name: 'species' }
  | { name: 'species-detail'; scientific: string }
  | { name: 'map' }
  | { name: 'settings' }
  | { name: 'help' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, ...rest] = path.split('/');
  const tail = rest.map(decodeURIComponent).join('/');
  switch (head) {
    case 'recordings':
      return tail ? { name: 'recording', id: tail } : { name: 'recordings' };
    case 'species':
      return tail ? { name: 'species-detail', scientific: tail } : { name: 'species' };
    case 'map':
      return { name: 'map' };
    case 'settings':
      return { name: 'settings' };
    case 'help':
      return { name: 'help' };
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
    case 'map':
      return '#/map';
    case 'settings':
      return '#/settings';
    case 'help':
      return '#/help';
  }
}

export function navigate(route: Route): void {
  location.hash = hrefFor(route);
}

export function speciesHref(scientific: string): string {
  return hrefFor({ name: 'species-detail', scientific });
}
