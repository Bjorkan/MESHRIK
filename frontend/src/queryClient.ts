import { QueryClient } from '@tanstack/react-query';

export interface MessagePageQueryKey {
  type?: 'PRIV' | 'CHAN';
  conversationKey?: string;
  before?: number;
  beforeId?: number;
  after?: number;
  afterId?: number;
  search?: string;
}

/**
 * Query keys are ordered from broad to specific so callers can invalidate a domain
 * without knowing its individual query shape.
 */
export const queryKeys = {
  health: () => ['health'] as const,
  contacts: () => ['contacts'] as const,
  channels: () => ['channels'] as const,
  settings: () => ['settings'] as const,
  radioConfig: () => ['radio', 'config'] as const,
  radioJobs: () => ['radio', 'jobs'] as const,
  radioActivity: () => ['radio', 'activity'] as const,
  undecryptedCount: () => ['packets', 'undecrypted-count'] as const,
  unreads: () => ['unreads'] as const,
  conversation: (type: 'contact' | 'channel', id: string) =>
    ['messages', 'conversation', type, id] as const,
  messagePages: (params: MessagePageQueryKey) => ['messages', 'pages', params] as const,
};

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 30 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
        // WebSocket reconnect handling performs deliberate domain invalidation.
        refetchOnReconnect: false,
      },
      mutations: {
        // Radio and message mutations may have succeeded even when HTTP timed out.
        retry: false,
      },
    },
  });
}
