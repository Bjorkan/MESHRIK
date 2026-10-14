import { act, renderHook as baseRenderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { api } from '../api';
import {
  reconcileConversationMessages,
  useConversationMessages,
} from '../hooks/useConversationMessages';
import { queryKeys } from '../queryClient';
import type { Conversation, Message } from '../types';

const mockGetMessages = vi.fn<typeof api.getMessages>();
const mockGetMessagesAround = vi.fn();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity } },
});
const QueryWrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);
const renderHook: typeof baseRenderHook = (render, options) =>
  baseRenderHook(render, { ...options, wrapper: QueryWrapper });

vi.mock('../api', () => ({
  api: {
    getMessages: (...args: Parameters<typeof api.getMessages>) => mockGetMessages(...args),
    getMessagesAround: (...args: unknown[]) => mockGetMessagesAround(...args),
  },
  isAbortError: (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
}));

const mockToastError = vi.fn();
vi.mock('../components/ui/sonner', () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

function createConversation(): Conversation {
  return {
    type: 'contact',
    id: 'abc123',
    name: 'Test Contact',
  };
}

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 42,
    type: 'PRIV',
    conversation_key: 'abc123',
    text: 'hello',
    sender_timestamp: 1700000000,
    received_at: 1700000001,
    paths: null,
    txt_type: 0,
    signature: null,
    sender_key: null,
    outgoing: true,
    acked: 0,
    sender_name: null,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useConversationMessages ACK ordering', () => {
  beforeEach(() => {
    mockGetMessages.mockReset();
    queryClient.clear();
    mockToastError.mockReset();
  });

  it('applies buffered ACK when message is added after ACK event', async () => {
    mockGetMessages.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useConversationMessages(createConversation()));

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.messagesLoading).toBe(false));

    const paths = [{ path: 'A1B2', received_at: 1700000010 }];
    act(() => {
      result.current.receiveMessageAck(42, 2, paths);
    });

    act(() => {
      const { added } = result.current.observeMessage(
        createMessage({ id: 42, acked: 0, paths: null })
      );
      expect(added).toBe(true);
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].acked).toBe(2);
    expect(result.current.messages[0].paths).toEqual(paths);
  });

  it('applies buffered ACK to message returned by in-flight fetch', async () => {
    const deferred = createDeferred<Message[]>();
    mockGetMessages.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useConversationMessages(createConversation()));
    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));

    const paths = [{ path: 'C3D4', received_at: 1700000011 }];
    act(() => {
      result.current.receiveMessageAck(42, 1, paths);
    });

    deferred.resolve([createMessage({ id: 42, acked: 0, paths: null })]);

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].acked).toBe(1);
    expect(result.current.messages[0].paths).toEqual(paths);
  });

  it('preserves a WebSocket-arrived message when latest fetch resolves afterward', async () => {
    const deferred = createDeferred<Message[]>();
    mockGetMessages.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useConversationMessages(createConversation()));
    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));

    act(() => {
      const { added } = result.current.observeMessage(
        createMessage({
          id: 99,
          text: 'ws-arrived',
          sender_timestamp: 1700000099,
          received_at: 1700000099,
        })
      );
      expect(added).toBe(true);
    });

    deferred.resolve([
      createMessage({
        id: 42,
        text: 'rest-fetched',
        sender_timestamp: 1700000000,
        received_at: 1700000001,
      }),
    ]);

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.some((msg) => msg.text === 'rest-fetched')).toBe(true);
    expect(result.current.messages.some((msg) => msg.text === 'ws-arrived')).toBe(true);
  });

  it('keeps highest ACK state when out-of-order ACK updates arrive', async () => {
    mockGetMessages.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useConversationMessages(createConversation()));

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.messagesLoading).toBe(false));

    act(() => {
      result.current.observeMessage(createMessage({ id: 42, acked: 0, paths: null }));
    });

    const highAckPaths = [
      { path: 'A1B2', received_at: 1700000010 },
      { path: 'A1C3', received_at: 1700000011 },
    ];
    const staleAckPaths = [{ path: 'A1B2', received_at: 1700000010 }];

    act(() => {
      result.current.receiveMessageAck(42, 3, highAckPaths);
      result.current.receiveMessageAck(42, 2, staleAckPaths);
    });

    await waitFor(() => expect(result.current.messages[0]?.acked).toBe(3));
    expect(result.current.messages[0].paths).toEqual(highAckPaths);
  });

  it('preserves ACK and path updates that arrive while a latest fetch is in flight', async () => {
    const deferred = createDeferred<Message[]>();
    mockGetMessages.mockReturnValueOnce(deferred.promise);
    queryClient.setQueryData(queryKeys.conversationView('contact', 'abc123', null), {
      pages: [
        {
          messages: [createMessage({ id: 42, acked: 0, paths: null })],
          hasOlder: false,
          hasNewer: false,
        },
      ],
      pageParams: [{ direction: 'latest' }],
    });
    const { result } = renderHook(() => useConversationMessages(createConversation()));
    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));

    const livePath = { path: 'LIVE', received_at: 1700000099 };
    act(() => {
      result.current.receiveMessageAck(42, 3, [livePath], 777);
    });
    await waitFor(() => expect(result.current.messages[0].acked).toBe(3));

    deferred.resolve([
      createMessage({
        id: 42,
        acked: 1,
        paths: [{ path: 'REST', received_at: 1700000002 }],
        packet_id: null,
      }),
    ]);

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages[0].acked).toBe(3);
    expect(result.current.messages[0].paths).toContainEqual(livePath);
    expect(result.current.messages[0].packet_id).toBe(777);
  });
});

describe('reconcileConversationMessages deletion boundary', () => {
  it('merges monotonic ACK, path and packet revisions from the live cache', () => {
    const live = createMessage({
      id: 1,
      acked: 3,
      paths: [{ path: 'LIVE', received_at: 1700000003 }],
      packet_id: 777,
    });
    const fetched = createMessage({
      id: 1,
      acked: 1,
      paths: [{ path: 'REST', received_at: 1700000002 }],
      packet_id: null,
    });

    expect(reconcileConversationMessages([live], [fetched], false, new Set([1]))).toEqual([
      {
        ...fetched,
        acked: 3,
        paths: [
          { path: 'REST', received_at: 1700000002 },
          { path: 'LIVE', received_at: 1700000003 },
        ],
        packet_id: 777,
      },
    ]);
  });

  it('removes server-deleted messages that existed when the request started', () => {
    const removed = createMessage({ id: 1, text: 'deleted on server' });
    const retained = createMessage({ id: 2, text: 'still present' });

    expect(
      reconcileConversationMessages([removed, retained], [retained], false, new Set([1, 2]))
    ).toEqual([retained]);
  });

  it('does not mistake a message received during the request for a server deletion', () => {
    const requestStart = createMessage({ id: 1, text: 'snapshot' });
    const fetched = createMessage({ id: 1, text: 'snapshot updated' });
    const live = createMessage({ id: 2, text: 'arrived live', received_at: 1700000010 });

    expect(
      reconcileConversationMessages([requestStart, live], [fetched], false, new Set([1]))
    ).toEqual([fetched, live]);
  });
});

describe('useConversationMessages conversation switch', () => {
  beforeEach(() => {
    mockGetMessages.mockReset();
    queryClient.clear();
  });

  it('resets loadingOlder when switching conversations mid-fetch', async () => {
    const convA: Conversation = { type: 'contact', id: 'conv_a', name: 'Contact A' };
    const convB: Conversation = { type: 'contact', id: 'conv_b', name: 'Contact B' };

    // Conv A initial fetch: return 200 messages so hasOlderMessages = true
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      createMessage({
        id: i + 1,
        conversation_key: 'conv_a',
        text: `msg-${i}`,
        sender_timestamp: 1700000000 + i,
        received_at: 1700000000 + i,
      })
    );
    mockGetMessages.mockResolvedValueOnce(fullPage);

    const { result, rerender } = renderHook(
      ({ conv }: { conv: Conversation }) => useConversationMessages(conv),
      { initialProps: { conv: convA } }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.hasOlderMessages).toBe(true);
    expect(result.current.messages).toHaveLength(200);

    // Start fetching older messages — use a deferred promise so it stays in-flight
    const olderDeferred = createDeferred<Message[]>();
    mockGetMessages.mockReturnValueOnce(olderDeferred.promise);

    act(() => {
      result.current.fetchOlderMessages();
    });

    await waitFor(() => expect(result.current.loadingOlder).toBe(true));

    // Switch to conv B while older-messages fetch is still pending
    mockGetMessages.mockResolvedValueOnce([createMessage({ id: 999, conversation_key: 'conv_b' })]);
    await act(async () => {
      rerender({ conv: convB });
    });

    // loadingOlder must reset immediately — no phantom spinner in conv B
    await waitFor(() => expect(result.current.loadingOlder).toBe(false));
    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].conversation_key).toBe('conv_b');

    // Resolve the stale older-messages fetch — should not affect conv B's state
    await act(async () => {
      olderDeferred.resolve([
        createMessage({ id: 500, conversation_key: 'conv_a', text: 'stale-old' }),
      ]);
      await Promise.resolve();
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].conversation_key).toBe('conv_b');
  });

  it('reloads the active conversation from source when requested', async () => {
    const conv = createConversation();
    mockGetMessages
      .mockResolvedValueOnce([
        createMessage({ id: 1, text: 'keep me', sender_timestamp: 1700000000, received_at: 1 }),
        createMessage({
          id: 2,
          text: 'blocked later',
          sender_timestamp: 1700000001,
          received_at: 2,
        }),
      ])
      .mockResolvedValueOnce([
        createMessage({ id: 1, text: 'keep me', sender_timestamp: 1700000000, received_at: 1 }),
      ]);

    const { result } = renderHook(() => useConversationMessages(conv));

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages.map((msg) => msg.text)).toEqual(['keep me', 'blocked later']);

    act(() => {
      result.current.reloadCurrentConversation();
    });

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages.map((msg) => msg.text)).toEqual(['keep me']);
  });

  it('aborts in-flight fetch when switching conversations', async () => {
    const convA: Conversation = { type: 'contact', id: 'conv_a', name: 'Contact A' };
    const convB: Conversation = { type: 'contact', id: 'conv_b', name: 'Contact B' };

    // Conv A: never resolves (simulates slow network)
    mockGetMessages.mockReturnValueOnce(new Promise(() => {}));

    const { result, rerender } = renderHook(
      ({ conv }: { conv: Conversation }) => useConversationMessages(conv),
      { initialProps: { conv: convA } }
    );

    // Should be loading
    expect(result.current.messagesLoading).toBe(true);

    // Verify the API was called with an AbortSignal
    const firstCallSignal = (mockGetMessages as Mock).mock.calls[0]?.[1];
    expect(firstCallSignal).toBeInstanceOf(AbortSignal);

    // Switch to conv B
    mockGetMessages.mockResolvedValueOnce([createMessage({ id: 1, conversation_key: 'conv_b' })]);
    rerender({ conv: convB });

    // The signal from conv A's fetch should have been aborted
    expect(firstCallSignal.aborted).toBe(true);

    // Conv B should load normally
    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].conversation_key).toBe('conv_b');
  });
});

describe('useConversationMessages background reconcile ordering', () => {
  beforeEach(() => {
    mockGetMessages.mockReset();
    queryClient.clear();
  });

  it('ignores stale reconnect reconcile responses that finish after newer ones', async () => {
    const conv = createConversation();
    mockGetMessages.mockResolvedValueOnce([
      createMessage({ id: 42, text: 'initial snapshot', acked: 0 }),
    ]);

    const { result } = renderHook(() => useConversationMessages(conv));

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages[0].text).toBe('initial snapshot');

    const firstReconcile = createDeferred<Message[]>();
    const secondReconcile = createDeferred<Message[]>();
    mockGetMessages
      .mockReturnValueOnce(firstReconcile.promise)
      .mockReturnValueOnce(secondReconcile.promise);

    act(() => {
      result.current.reconcileOnReconnect();
      result.current.reconcileOnReconnect();
    });

    secondReconcile.resolve([createMessage({ id: 42, text: 'newer snapshot', acked: 2 })]);
    await waitFor(() => expect(result.current.messages[0].text).toBe('newer snapshot'));
    expect(result.current.messages[0].acked).toBe(2);

    firstReconcile.resolve([createMessage({ id: 42, text: 'stale snapshot', acked: 1 })]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.messages[0].text).toBe('newer snapshot');
    expect(result.current.messages[0].acked).toBe(2);
  });

  it('clears stale hasOlderMessages when cached conversations reconcile to a short latest page', async () => {
    const conv = createConversation();
    const cachedMessage = createMessage({ id: 42, text: 'cached snapshot' });

    queryClient.setQueryData(queryKeys.conversationView('contact', conv.id, null), {
      pages: [{ messages: [cachedMessage], hasOlder: true, hasNewer: false }],
      pageParams: [{ direction: 'latest' }],
    });

    mockGetMessages.mockResolvedValueOnce([cachedMessage]);

    const { result } = renderHook(() => useConversationMessages(conv));

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.hasOlderMessages).toBe(true);

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.hasOlderMessages).toBe(false));
  });
});

describe('useConversationMessages older-page dedup and reentry', () => {
  beforeEach(() => {
    mockGetMessages.mockReset();
    queryClient.clear();
  });

  it('prevents duplicate overlapping older-page fetches in the same tick', async () => {
    const conv: Conversation = { type: 'contact', id: 'conv_a', name: 'Contact A' };

    const fullPage = Array.from({ length: 200 }, (_, i) =>
      createMessage({
        id: i + 1,
        conversation_key: 'conv_a',
        text: `msg-${i + 1}`,
        sender_timestamp: 1700000000 + i,
        received_at: 1700000000 + i,
      })
    );
    mockGetMessages.mockResolvedValueOnce(fullPage);

    const olderDeferred = createDeferred<Message[]>();
    mockGetMessages.mockReturnValueOnce(olderDeferred.promise);

    const { result } = renderHook(() => useConversationMessages(conv));

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages).toHaveLength(200);
    expect(result.current.hasOlderMessages).toBe(true);

    act(() => {
      void result.current.fetchOlderMessages();
      void result.current.fetchOlderMessages();
    });

    expect(mockGetMessages).toHaveBeenCalledTimes(2); // initial page + one older fetch

    olderDeferred.resolve([
      createMessage({
        id: 0,
        conversation_key: 'conv_a',
        text: 'older-msg',
        sender_timestamp: 1699999999,
        received_at: 1699999999,
      }),
    ]);

    await waitFor(() => expect(result.current.loadingOlder).toBe(false));
    expect(result.current.messages).toHaveLength(201);
    expect(result.current.messages.filter((msg) => msg.id === 0)).toHaveLength(1);
  });

  it('does not append duplicate messages from an overlapping older page', async () => {
    const conv: Conversation = { type: 'contact', id: 'conv_a', name: 'Contact A' };

    const fullPage = Array.from({ length: 200 }, (_, i) =>
      createMessage({
        id: i + 1,
        conversation_key: 'conv_a',
        text: `msg-${i + 1}`,
        sender_timestamp: 1700000000 + i,
        received_at: 1700000000 + i,
      })
    );
    mockGetMessages.mockResolvedValueOnce(fullPage);
    mockGetMessages.mockResolvedValueOnce([
      createMessage({
        id: 1,
        conversation_key: 'conv_a',
        text: 'msg-1',
        sender_timestamp: 1700000000,
        received_at: 1700000000,
      }),
      createMessage({
        id: 0,
        conversation_key: 'conv_a',
        text: 'older-msg',
        sender_timestamp: 1699999999,
        received_at: 1699999999,
      }),
    ]);

    const { result } = renderHook(() => useConversationMessages(conv));

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages).toHaveLength(200);

    await act(async () => {
      await result.current.fetchOlderMessages();
    });

    await waitFor(() => {
      expect(result.current.messages.filter((msg) => msg.id === 1)).toHaveLength(1);
      expect(result.current.messages.filter((msg) => msg.id === 0)).toHaveLength(1);
      expect(result.current.messages).toHaveLength(201);
    });
  });

  it('aborts stale older-page requests on conversation switch without toasting', async () => {
    const convA: Conversation = { type: 'contact', id: 'conv_a', name: 'Contact A' };
    const convB: Conversation = { type: 'contact', id: 'conv_b', name: 'Contact B' };

    const fullPage = Array.from({ length: 200 }, (_, i) =>
      createMessage({
        id: i + 1,
        conversation_key: 'conv_a',
        text: `msg-${i + 1}`,
        sender_timestamp: 1700000000 + i,
        received_at: 1700000000 + i,
      })
    );
    mockGetMessages.mockResolvedValueOnce(fullPage);

    const olderDeferred = createDeferred<Message[]>();
    let olderSignal: AbortSignal | undefined;
    mockGetMessages.mockImplementationOnce((_, signal?: AbortSignal) => {
      olderSignal = signal;
      signal?.addEventListener('abort', () => {
        olderDeferred.resolve([]);
      });
      return new Promise<Message[]>((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });

    const { result, rerender } = renderHook(
      ({ conv }: { conv: Conversation }) => useConversationMessages(conv),
      { initialProps: { conv: convA } }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    act(() => {
      void result.current.fetchOlderMessages();
    });

    await waitFor(() => expect(result.current.loadingOlder).toBe(true));

    mockGetMessages.mockResolvedValueOnce([createMessage({ id: 999, conversation_key: 'conv_b' })]);
    rerender({ conv: convB });

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(olderSignal?.aborted).toBe(true);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

describe('useConversationMessages forward pagination', () => {
  beforeEach(() => {
    mockGetMessages.mockReset();
    mockGetMessagesAround.mockReset();
    queryClient.clear();
    mockToastError.mockReset();
  });

  it('fetchNewerMessages loads newer messages and appends them', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };

    // Initial load returns messages that indicate there are newer ones
    // (we'll set hasNewerMessages via targetMessageId + getMessagesAround)
    const initialMessages = Array.from({ length: 3 }, (_, i) =>
      createMessage({
        id: i + 1,
        conversation_key: 'ch1',
        text: `msg-${i}`,
        sender_timestamp: 1700000000 + i,
        received_at: 1700000000 + i,
      })
    );

    mockGetMessagesAround.mockResolvedValueOnce({
      messages: initialMessages,
      has_older: false,
      has_newer: true,
    });

    const { result } = renderHook(
      ({ conv, target }: { conv: Conversation; target: number | null }) =>
        useConversationMessages(conv, target),
      { initialProps: { conv, target: 2 } }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages).toHaveLength(3);
    expect(result.current.hasNewerMessages).toBe(true);

    // Now fetch newer messages
    const newerMessages = [
      createMessage({
        id: 4,
        conversation_key: 'ch1',
        text: 'msg-3',
        sender_timestamp: 1700000003,
        received_at: 1700000003,
      }),
    ];
    mockGetMessages.mockResolvedValueOnce(newerMessages);

    await act(async () => {
      await result.current.fetchNewerMessages();
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(4);
      // Less than page size → no more newer messages
      expect(result.current.hasNewerMessages).toBe(false);
    });
  });

  it('fetchNewerMessages deduplicates against seen messages', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };

    const initialMessages = [
      createMessage({
        id: 1,
        conversation_key: 'ch1',
        text: 'msg-0',
        sender_timestamp: 1700000000,
        received_at: 1700000000,
      }),
    ];

    mockGetMessagesAround.mockResolvedValueOnce({
      messages: initialMessages,
      has_older: false,
      has_newer: true,
    });

    const { result } = renderHook(
      ({ conv, target }: { conv: Conversation; target: number | null }) =>
        useConversationMessages(conv, target),
      { initialProps: { conv, target: 1 } }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));

    // Simulate WS adding a message with the same content key
    act(() => {
      result.current.observeMessage(
        createMessage({
          id: 2,
          conversation_key: 'ch1',
          text: 'duplicate-content',
          sender_timestamp: 1700000001,
          received_at: 1700000001,
        })
      );
    });

    // fetchNewerMessages returns the same content (different id but same content key)
    mockGetMessages.mockResolvedValueOnce([
      createMessage({
        id: 3,
        conversation_key: 'ch1',
        text: 'duplicate-content',
        sender_timestamp: 1700000001,
        received_at: 1700000001,
      }),
    ]);

    await act(async () => {
      await result.current.fetchNewerMessages();
    });

    // Should not have a duplicate
    await waitFor(() => {
      const dupes = result.current.messages.filter((m) => m.text === 'duplicate-content');
      expect(dupes).toHaveLength(1);
    });
  });

  it('defers reconnect reconcile until forward pagination reaches the live tail', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };

    mockGetMessagesAround.mockResolvedValueOnce({
      messages: [
        createMessage({
          id: 1,
          conversation_key: 'ch1',
          text: 'older-context',
          sender_timestamp: 1700000000,
          received_at: 1700000000,
        }),
      ],
      has_older: false,
      has_newer: true,
    });

    const { result } = renderHook(
      ({ conv, target }: { conv: Conversation; target: number | null }) =>
        useConversationMessages(conv, target),
      { initialProps: { conv, target: 1 } }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.hasNewerMessages).toBe(true);

    act(() => {
      result.current.reconcileOnReconnect();
    });

    expect(mockGetMessages).not.toHaveBeenCalled();

    mockGetMessages
      .mockResolvedValueOnce([
        createMessage({
          id: 2,
          conversation_key: 'ch1',
          text: 'newer-page',
          sender_timestamp: 1700000001,
          received_at: 1700000001,
        }),
      ])
      .mockResolvedValueOnce([
        createMessage({
          id: 2,
          conversation_key: 'ch1',
          text: 'newer-page',
          sender_timestamp: 1700000001,
          received_at: 1700000001,
          acked: 3,
        }),
      ])
      .mockResolvedValueOnce([
        createMessage({
          id: 1,
          conversation_key: 'ch1',
          text: 'older-context',
          sender_timestamp: 1700000000,
          received_at: 1700000000,
        }),
      ]);

    await act(async () => {
      await result.current.fetchNewerMessages();
    });

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(result.current.messages.find((message) => message.id === 2)?.acked).toBe(3)
    );
    expect(result.current.hasNewerMessages).toBe(false);
  });

  it('jumpToBottom clears hasNewerMessages and refetches latest', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };

    const aroundMessages = [
      createMessage({
        id: 5,
        conversation_key: 'ch1',
        text: 'around-msg',
        sender_timestamp: 1700000005,
        received_at: 1700000005,
      }),
    ];

    mockGetMessagesAround.mockResolvedValueOnce({
      messages: aroundMessages,
      has_older: true,
      has_newer: true,
    });

    const { result } = renderHook(
      ({ conv, target }: { conv: Conversation; target: number | null }) =>
        useConversationMessages(conv, target),
      { initialProps: { conv, target: 5 } }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.hasNewerMessages).toBe(true);

    // Jump to bottom
    const latestMessages = [
      createMessage({
        id: 10,
        conversation_key: 'ch1',
        text: 'latest-msg',
        sender_timestamp: 1700000010,
        received_at: 1700000010,
      }),
    ];
    mockGetMessages.mockResolvedValueOnce(latestMessages);

    act(() => {
      result.current.jumpToBottom();
    });

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(result.current.messagesLoading).toBe(false);
      expect(result.current.hasNewerMessages).toBe(false);
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].text).toBe('latest-msg');
    });
  });

  it('coalesces concurrent jump-to-bottom requests into one Query fetch', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };
    mockGetMessagesAround.mockResolvedValueOnce({
      messages: [createMessage({ id: 5, conversation_key: 'ch1' })],
      has_older: true,
      has_newer: true,
    });
    const latest = createDeferred<Message[]>();
    mockGetMessages.mockReturnValueOnce(latest.promise);

    const { result } = renderHook(() => useConversationMessages(conv, 5));
    await waitFor(() => expect(result.current.messagesLoading).toBe(false));

    act(() => {
      result.current.jumpToBottom();
      result.current.jumpToBottom();
    });

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));
    latest.resolve([createMessage({ id: 10, conversation_key: 'ch1', text: 'tail' })]);
    await waitFor(() => expect(result.current.messages[0]?.text).toBe('tail'));
    expect(mockGetMessages).toHaveBeenCalledTimes(1);
  });

  it('aborts a stale around-message request when the jump target changes', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };
    let firstSignal: AbortSignal | undefined;
    mockGetMessagesAround.mockImplementationOnce(
      (_messageId: number, _type: string, _conversationId: string, signal?: AbortSignal) => {
        firstSignal = signal;
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      }
    );
    mockGetMessagesAround.mockResolvedValueOnce({
      messages: [createMessage({ id: 9, conversation_key: 'ch1', text: 'new target' })],
      has_older: false,
      has_newer: false,
    });

    const { result, rerender } = renderHook(
      ({ target }: { target: number }) => useConversationMessages(conv, target),
      { initialProps: { target: 5 } }
    );
    await waitFor(() => expect(mockGetMessagesAround).toHaveBeenCalledTimes(1));

    rerender({ target: 9 });

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages.map((message) => message.text)).toEqual(['new target']);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('aborts an in-flight jump request on unmount without surfacing an error', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };
    let signal: AbortSignal | undefined;
    mockGetMessagesAround.mockImplementationOnce(
      (_messageId: number, _type: string, _conversationId: string, requestSignal?: AbortSignal) => {
        signal = requestSignal;
        return new Promise((_, reject) => {
          requestSignal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      }
    );

    const { unmount } = renderHook(() => useConversationMessages(conv, 5));
    await waitFor(() => expect(mockGetMessagesAround).toHaveBeenCalledTimes(1));
    unmount();

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('jumpToBottom clears deferred reconnect reconcile without an extra reconcile fetch', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };

    mockGetMessagesAround.mockResolvedValueOnce({
      messages: [
        createMessage({
          id: 5,
          conversation_key: 'ch1',
          text: 'around-msg',
          sender_timestamp: 1700000005,
          received_at: 1700000005,
        }),
      ],
      has_older: true,
      has_newer: true,
    });

    const { result } = renderHook(
      ({ conv, target }: { conv: Conversation; target: number | null }) =>
        useConversationMessages(conv, target),
      { initialProps: { conv, target: 5 } }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));

    act(() => {
      result.current.reconcileOnReconnect();
    });

    mockGetMessages.mockResolvedValueOnce([
      createMessage({
        id: 10,
        conversation_key: 'ch1',
        text: 'latest-msg',
        sender_timestamp: 1700000010,
        received_at: 1700000010,
      }),
    ]);

    act(() => {
      result.current.jumpToBottom();
    });

    await waitFor(() => expect(mockGetMessages).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(result.current.messagesLoading).toBe(false);
      expect(result.current.messages[0].text).toBe('latest-msg');
      expect(result.current.hasNewerMessages).toBe(false);
    });
  });

  it('aborts stale newer-page requests on conversation switch without toasting', async () => {
    const convA: Conversation = { type: 'channel', id: 'ch1', name: 'Channel A' };
    const convB: Conversation = { type: 'channel', id: 'ch2', name: 'Channel B' };

    mockGetMessagesAround.mockResolvedValueOnce({
      messages: [
        createMessage({
          id: 1,
          type: 'CHAN',
          conversation_key: 'ch1',
          text: 'msg-0',
          sender_timestamp: 1700000000,
          received_at: 1700000000,
        }),
      ],
      has_older: false,
      has_newer: true,
    });

    let newerSignal: AbortSignal | undefined;
    mockGetMessages.mockImplementationOnce((_, signal?: AbortSignal) => {
      newerSignal = signal;
      return new Promise<Message[]>((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });

    const initialProps: { conv: Conversation; target: number | null } = {
      conv: convA,
      target: 1,
    };

    const { result, rerender } = renderHook(
      ({ conv, target }: { conv: Conversation; target: number | null }) =>
        useConversationMessages(conv, target),
      { initialProps }
    );

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));

    act(() => {
      void result.current.fetchNewerMessages();
    });

    await waitFor(() => expect(result.current.loadingNewer).toBe(true));

    mockGetMessages.mockResolvedValueOnce([
      createMessage({
        id: 999,
        type: 'CHAN',
        conversation_key: 'ch2',
        text: 'conv-b',
      }),
    ]);
    rerender({ conv: convB, target: null });

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(newerSignal?.aborted).toBe(true);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('preserves around-loaded messages when the jump target is cleared in the same conversation', async () => {
    const conv: Conversation = { type: 'channel', id: 'ch1', name: 'Channel' };

    const aroundMessages = [
      createMessage({
        id: 4,
        conversation_key: 'ch1',
        text: 'older-context',
        sender_timestamp: 1700000004,
        received_at: 1700000004,
      }),
      createMessage({
        id: 5,
        conversation_key: 'ch1',
        text: 'target-message',
        sender_timestamp: 1700000005,
        received_at: 1700000005,
      }),
      createMessage({
        id: 6,
        conversation_key: 'ch1',
        text: 'newer-context',
        sender_timestamp: 1700000006,
        received_at: 1700000006,
      }),
    ];

    mockGetMessagesAround.mockResolvedValueOnce({
      messages: aroundMessages,
      has_older: true,
      has_newer: true,
    });

    const { result, rerender } = renderHook<
      ReturnType<typeof useConversationMessages>,
      { conv: Conversation; target: number | null }
    >(({ conv, target }) => useConversationMessages(conv, target), {
      initialProps: { conv, target: 5 },
    });

    await waitFor(() => expect(result.current.messagesLoading).toBe(false));
    expect(result.current.messages.map((message) => message.text)).toEqual([
      'older-context',
      'target-message',
      'newer-context',
    ]);
    expect(mockGetMessages).not.toHaveBeenCalled();

    rerender({ conv, target: null });

    await waitFor(() =>
      expect(result.current.messages.map((message) => message.text)).toEqual([
        'older-context',
        'target-message',
        'newer-context',
      ])
    );
    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(result.current.hasNewerMessages).toBe(true);
  });
});
