import type { Conversation } from '../types';

export const REOPEN_LAST_CONVERSATION_KEY = 'meshrik-reopen-last-conversation';
export const LAST_VIEWED_CONVERSATION_KEY = 'meshrik-last-viewed-conversation';

const SUPPORTED_TYPES: Conversation['type'][] = [
  'contact',
  'channel',
  'raw',
  'map',
  'visualizer',
  'trace',
  'radio-activity',
];

function isSupportedType(value: unknown): value is Conversation['type'] {
  return typeof value === 'string' && SUPPORTED_TYPES.includes(value as Conversation['type']);
}

export function getReopenLastConversationEnabled(): boolean {
  try {
    return localStorage.getItem(REOPEN_LAST_CONVERSATION_KEY) === '1';
  } catch {
    return false;
  }
}

export function setReopenLastConversationEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(REOPEN_LAST_CONVERSATION_KEY, '1');
      return;
    }

    localStorage.removeItem(REOPEN_LAST_CONVERSATION_KEY);
    localStorage.removeItem(LAST_VIEWED_CONVERSATION_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

export function saveLastViewedConversation(conversation: Conversation): void {
  try {
    localStorage.setItem(LAST_VIEWED_CONVERSATION_KEY, JSON.stringify(conversation));
  } catch {
    // localStorage may be unavailable
  }
}

export function getLastViewedConversation(): Conversation | null {
  try {
    const raw = localStorage.getItem(LAST_VIEWED_CONVERSATION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<Conversation>;
    if (
      !isSupportedType(parsed.type) ||
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string'
    ) {
      return null;
    }

    if (parsed.type !== 'map') {
      return {
        type: parsed.type,
        id: parsed.id,
        name: parsed.name,
      };
    }

    return {
      type: 'map',
      id: parsed.id,
      name: parsed.name,
      ...(typeof parsed.mapFocusKey === 'string' && { mapFocusKey: parsed.mapFocusKey }),
    };
  } catch {
    return null;
  }
}
