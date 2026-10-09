import { describe, expect, it } from 'vitest';

import { createAppQueryClient, queryKeys } from '../queryClient';

describe('Query client conventions', () => {
  it('uses stable hierarchical keys for server-state domains', () => {
    expect(queryKeys.contacts()).toEqual(['contacts']);
    expect(queryKeys.channels()).toEqual(['channels']);
    expect(queryKeys.settings()).toEqual(['settings']);
    expect(queryKeys.unreads()).toEqual(['unreads']);
    expect(queryKeys.conversation('contact', 'abc')).toEqual([
      'messages',
      'conversation',
      'contact',
      'abc',
    ]);
    expect(queryKeys.messagePages({ type: 'CHAN', conversationKey: 'room', before: 123 })).toEqual([
      'messages',
      'pages',
      { type: 'CHAN', conversationKey: 'room', before: 123 },
    ]);
  });

  it('never retries mutations automatically', () => {
    const queryClient = createAppQueryClient();

    expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
    expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    expect(queryClient.getDefaultOptions().queries?.refetchOnReconnect).toBe(false);
  });
});
