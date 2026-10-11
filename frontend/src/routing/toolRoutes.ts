import type { Conversation } from '../types';

export interface MapSearch {
  focus?: string;
}

export function validateMapSearch(search: Record<string, unknown>): MapSearch {
  const focus = typeof search.focus === 'string' ? search.focus.trim() : '';
  return focus ? { focus } : {};
}

export function getMapFocusPath(publicKey: string): string {
  return `/map?focus=${encodeURIComponent(publicKey)}`;
}

export function getToolConversation(
  pathname: string,
  search: Record<string, unknown>
): Conversation | null {
  switch (pathname) {
    case '/raw':
      return { type: 'raw', id: 'raw', name: 'Raw Packet Feed' };
    case '/map': {
      const { focus } = validateMapSearch(search);
      return { type: 'map', id: 'map', name: 'Node Map', ...(focus ? { mapFocusKey: focus } : {}) };
    }
    case '/visualizer':
      return { type: 'visualizer', id: 'visualizer', name: 'Mesh Visualizer' };
    case '/search':
      return { type: 'search', id: 'search', name: 'Message Search' };
    case '/trace':
      return { type: 'trace', id: 'trace', name: 'Trace' };
    case '/radio-activity':
      return { type: 'radio-activity', id: 'radio-activity', name: 'Radio Activity' };
    default:
      return null;
  }
}
