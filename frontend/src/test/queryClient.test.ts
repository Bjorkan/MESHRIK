import { focusManager, InfiniteQueryObserver } from '@tanstack/react-query';
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

  it('keeps loaded infinite conversation pages stable across browser refocus', async () => {
    const queryClient = createAppQueryClient();
    const requestedPages: number[] = [];
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: queryKeys.conversationView('contact', 'abc', null),
      initialPageParam: 0,
      queryFn: async ({ pageParam }) => {
        requestedPages.push(pageParam);
        return {
          messages: [`page-${pageParam}`],
          nextPage: pageParam < 2 ? pageParam + 1 : undefined,
        };
      },
      getNextPageParam: (lastPage) => lastPage.nextPage,
    });
    queryClient.mount();
    const unsubscribe = observer.subscribe(() => undefined);

    try {
      await observer.refetch();
      await observer.fetchNextPage();
      await observer.fetchNextPage();
      expect(observer.getCurrentResult().data?.pages).toEqual([
        { messages: ['page-0'], nextPage: 1 },
        { messages: ['page-1'], nextPage: 2 },
        { messages: ['page-2'], nextPage: undefined },
      ]);
      expect(requestedPages).toEqual([0, 1, 2]);

      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();

      expect(requestedPages).toEqual([0, 1, 2]);
      expect(observer.getCurrentResult().data?.pages.map((page) => page.messages[0])).toEqual([
        'page-0',
        'page-1',
        'page-2',
      ]);
    } finally {
      focusManager.setFocused(undefined);
      unsubscribe();
      queryClient.unmount();
      queryClient.clear();
    }
  });
});
