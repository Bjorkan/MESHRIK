export interface MapSearch {
  focus?: string;
}

export interface MessageSearch {
  q?: string;
}

export function validateMapSearch(search: Record<string, unknown>): MapSearch {
  const focus = typeof search.focus === 'string' ? search.focus.trim() : '';
  return focus ? { focus } : {};
}

export function validateMessageSearch(search: Record<string, unknown>): MessageSearch {
  const query = typeof search.q === 'string' ? search.q.trim() : '';
  return query ? { q: query } : {};
}
