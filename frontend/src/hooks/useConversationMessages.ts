import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { toast } from '../components/ui/sonner';
import { api, isAbortError } from '../api';
import { queryKeys } from '../queryClient';
import type { Conversation, Message, MessagePath } from '../types';
import { getMessageContentKey } from '../utils/messageIdentity';

const MAX_PENDING_ACKS = 500;
const MESSAGE_PAGE_SIZE = 200;
export const MAX_CACHED_CONVERSATIONS = 20;

interface PendingAckUpdate {
  ackCount: number;
  paths?: MessagePath[];
  packetId?: number | null;
}

interface ConversationPage {
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
}

type ConversationPageParam =
  | { direction: 'latest' }
  | { direction: 'around'; messageId: number }
  | { direction: 'older'; receivedAt: number; messageId: number }
  | { direction: 'newer'; receivedAt: number; messageId: number };

type ConversationInfiniteData = InfiniteData<ConversationPage, ConversationPageParam>;

export function mergePendingAck(
  existing: PendingAckUpdate | undefined,
  ackCount: number,
  paths?: MessagePath[],
  packetId?: number | null
): PendingAckUpdate {
  if (!existing) {
    return {
      ackCount,
      ...(paths !== undefined && { paths }),
      ...(packetId !== undefined && { packetId }),
    };
  }
  if (ackCount > existing.ackCount) {
    return {
      ackCount,
      ...(paths !== undefined
        ? { paths }
        : existing.paths !== undefined && { paths: existing.paths }),
      ...(packetId !== undefined
        ? { packetId }
        : existing.packetId !== undefined && { packetId: existing.packetId }),
    };
  }
  if (ackCount < existing.ackCount) return existing;

  const packetIdChanged = packetId !== undefined && packetId !== existing.packetId;
  if (paths === undefined) return packetIdChanged ? { ...existing, packetId } : existing;
  if (paths.length >= (existing.paths?.length ?? -1)) {
    return { ackCount, paths, ...(packetId !== undefined && { packetId }) };
  }
  return packetIdChanged ? { ...existing, packetId } : existing;
}

function compareMessagePosition(left: Message, right: Message): number {
  return left.received_at === right.received_at
    ? left.id - right.id
    : left.received_at - right.received_at;
}

function messagesEqual(left: Message, right: Message): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function reconcileConversationMessages(
  current: Message[],
  fetched: Message[],
  fetchedHasOlderMessages = false,
  messageIdsAtRequestStart?: ReadonlySet<number>
): Message[] | null {
  const currentById = new Map(current.map((message) => [message.id, message]));
  const fetchedIds = new Set(fetched.map((message) => message.id));
  const oldestFetched = fetched.reduce<Message | null>(
    (oldest, message) =>
      !oldest || compareMessagePosition(message, oldest) < 0 ? message : oldest,
    null
  );
  const newestFetched = fetched.reduce<Message | null>(
    (newest, message) =>
      !newest || compareMessagePosition(message, newest) > 0 ? message : newest,
    null
  );
  const mayRemove = (message: Message) =>
    messageIdsAtRequestStart === undefined || messageIdsAtRequestStart.has(message.id);
  const isInsideFetchedRange = (message: Message) => {
    if (!fetchedHasOlderMessages) return true;
    return Boolean(
      oldestFetched &&
      newestFetched &&
      compareMessagePosition(message, oldestFetched) >= 0 &&
      compareMessagePosition(message, newestFetched) <= 0
    );
  };

  let changed = current.some(
    (message) => !fetchedIds.has(message.id) && mayRemove(message) && isInsideFetchedRange(message)
  );
  changed ||= fetched.some((message) => {
    const existing = currentById.get(message.id);
    return !existing || !messagesEqual(existing, message);
  });
  if (!changed) return null;
  return [
    ...fetched,
    ...current.filter(
      (message) =>
        !fetchedIds.has(message.id) && (!mayRemove(message) || !isInsideFetchedRange(message))
    ),
  ];
}

function isMessageConversation(conversation: Conversation | null): conversation is Conversation {
  return Boolean(
    conversation && !['raw', 'map', 'visualizer', 'search', 'trace'].includes(conversation.type)
  );
}

function conversationKind(conversation: Conversation): 'contact' | 'channel' {
  return conversation.type === 'channel' ? 'channel' : 'contact';
}

function messageConversationKind(message: Message): 'contact' | 'channel' {
  return message.type === 'CHAN' ? 'channel' : 'contact';
}

function isActiveConversationMessage(activeConversation: Conversation | null, message: Message) {
  if (!activeConversation) return false;
  return (
    ((message.type === 'CHAN' && activeConversation.type === 'channel') ||
      (message.type === 'PRIV' && activeConversation.type === 'contact')) &&
    message.conversation_key === activeConversation.id
  );
}

function flattenMessages(data: ConversationInfiniteData | undefined): Message[] {
  if (!data) return [];
  const seenIds = new Set<number>();
  const seenContent = new Set<string>();
  const messages: Message[] = [];
  for (const page of data.pages) {
    for (const message of page.messages) {
      const contentKey = getMessageContentKey(message);
      if (seenIds.has(message.id) || seenContent.has(contentKey)) continue;
      seenIds.add(message.id);
      seenContent.add(contentKey);
      messages.push(message);
    }
  }
  return messages.sort(compareMessagePosition);
}

function replaceWithSinglePage(
  messages: Message[],
  hasOlder: boolean,
  hasNewer = false
): ConversationInfiniteData {
  return {
    pages: [{ messages, hasOlder, hasNewer }],
    pageParams: [{ direction: 'latest' }],
  };
}

function mapQueryMessages(
  data: ConversationInfiniteData | undefined,
  update: (message: Message) => Message
): ConversationInfiniteData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      messages: page.messages.map(update),
    })),
  };
}

interface UseConversationMessagesResult {
  messages: Message[];
  messagesLoading: boolean;
  loadingOlder: boolean;
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  loadingNewer: boolean;
  fetchOlderMessages: () => Promise<void>;
  fetchNewerMessages: () => Promise<void>;
  jumpToBottom: () => void;
  reloadCurrentConversation: () => void;
  observeMessage: (msg: Message) => { added: boolean; activeConversation: boolean };
  receiveMessageAck: (
    messageId: number,
    ackCount: number,
    paths?: MessagePath[],
    packetId?: number | null
  ) => void;
  reconcileOnReconnect: () => void;
  renameConversationMessages: (oldId: string, newId: string) => void;
  removeConversationMessages: (conversationId: string) => void;
  clearConversationMessages: () => void;
}

export function useConversationMessages(
  activeConversation: Conversation | null,
  targetMessageId?: number | null
): UseConversationMessagesResult {
  const queryClient = useQueryClient();
  const pendingAcksRef = useRef<Map<number, PendingAckUpdate>>(new Map());
  const activeConversationRef = useRef(activeConversation);
  activeConversationRef.current = activeConversation;
  const reconcileRequestRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const olderControllerRef = useRef<AbortController | null>(null);
  const newerControllerRef = useRef<AbortController | null>(null);
  const pendingReconnectRef = useRef(false);
  const lastHandledTargetRef = useRef(targetMessageId ?? null);
  const resetForAnchorRef = useRef(false);
  const reconcileLatestRef = useRef<() => void>(() => {});
  const [, setCacheVersion] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [jumpLoading, setJumpLoading] = useState(false);
  const [anchor, setAnchor] = useState<{ conversationId: string | null; target: number | null }>(
    () => ({
      conversationId: activeConversation?.id ?? null,
      target: targetMessageId ?? null,
    })
  );

  const conversation = isMessageConversation(activeConversation) ? activeConversation : null;
  const conversationId = conversation?.id ?? null;
  const effectiveTarget =
    anchor.conversationId === conversationId ? anchor.target : (targetMessageId ?? null);
  const queryKey = useMemo(
    () =>
      conversation
        ? queryKeys.conversation(conversationKind(conversation), conversation.id)
        : (['messages', 'conversation', 'inactive'] as const),
    [conversation]
  );

  useEffect(() => {
    if (anchor.conversationId !== conversationId) {
      lastHandledTargetRef.current = targetMessageId ?? null;
      setAnchor({ conversationId, target: targetMessageId ?? null });
    } else if (targetMessageId != null && targetMessageId !== lastHandledTargetRef.current) {
      lastHandledTargetRef.current = targetMessageId;
      resetForAnchorRef.current = true;
      setAnchor({ conversationId, target: targetMessageId });
    }
  }, [anchor.conversationId, conversationId, targetMessageId]);

  useEffect(() => {
    if (!resetForAnchorRef.current || anchor.conversationId !== conversationId) return;
    resetForAnchorRef.current = false;
    void queryClient.resetQueries({ queryKey, exact: true });
  }, [anchor, conversationId, queryClient, queryKey]);

  useEffect(() => {
    setLoadingOlder(false);
    setLoadingNewer(false);
    return () => {
      olderControllerRef.current?.abort();
      newerControllerRef.current?.abort();
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
    };
  }, [conversationId]);

  const applyPendingAck = useCallback((message: Message): Message => {
    const pending = pendingAcksRef.current.get(message.id);
    if (!pending) return message;
    pendingAcksRef.current.delete(message.id);
    return {
      ...message,
      acked: Math.max(message.acked, pending.ackCount),
      ...(pending.paths !== undefined &&
        pending.paths.length >= (message.paths?.length ?? 0) && { paths: pending.paths }),
      ...(pending.packetId !== undefined && { packet_id: pending.packetId }),
    };
  }, []);

  const query = useInfiniteQuery<
    ConversationPage,
    Error,
    ConversationInfiniteData,
    typeof queryKey,
    ConversationPageParam
  >({
    queryKey,
    enabled: conversation !== null,
    initialPageParam: effectiveTarget
      ? ({ direction: 'around', messageId: effectiveTarget } as ConversationPageParam)
      : ({ direction: 'latest' } as ConversationPageParam),
    queryFn: async ({ pageParam, signal }): Promise<ConversationPage> => {
      if (!conversation) return { messages: [], hasOlder: false, hasNewer: false };
      const type: 'CHAN' | 'PRIV' = conversation.type === 'channel' ? 'CHAN' : 'PRIV';
      if (pageParam.direction === 'around') {
        const response = await api.getMessagesAround(
          pageParam.messageId,
          type,
          conversation.id,
          signal
        );
        return {
          messages: response.messages.map(applyPendingAck),
          hasOlder: response.has_older,
          hasNewer: response.has_newer,
        };
      }

      const params = {
        type,
        conversation_key: conversation.id,
        limit: MESSAGE_PAGE_SIZE,
        ...(pageParam.direction === 'older' && {
          before: pageParam.receivedAt,
          before_id: pageParam.messageId,
        }),
        ...(pageParam.direction === 'newer' && {
          after: pageParam.receivedAt,
          after_id: pageParam.messageId,
        }),
      };
      const messageIdsAtStart = new Set(
        flattenMessages(queryClient.getQueryData<ConversationInfiniteData>(queryKey)).map(
          (message) => message.id
        )
      );
      const fetched = (await api.getMessages(params, signal)).map(applyPendingAck);
      if (pageParam.direction === 'latest') {
        const current = flattenMessages(
          queryClient.getQueryData<ConversationInfiniteData>(queryKey)
        );
        const reconciled = reconcileConversationMessages(
          current,
          fetched,
          fetched.length >= MESSAGE_PAGE_SIZE,
          messageIdsAtStart
        );
        return {
          messages: reconciled ?? fetched,
          hasOlder: fetched.length >= MESSAGE_PAGE_SIZE,
          hasNewer: false,
        };
      }
      return {
        messages: fetched,
        hasOlder: pageParam.direction === 'older' ? fetched.length >= MESSAGE_PAGE_SIZE : true,
        hasNewer: pageParam.direction === 'newer' ? fetched.length >= MESSAGE_PAGE_SIZE : true,
      };
    },
    getNextPageParam: () => undefined,
    getPreviousPageParam: () => undefined,
  });

  const messages = useMemo(
    () => flattenMessages(query.data).map(applyPendingAck),
    [applyPendingAck, query.data]
  );
  const hasOlderMessages = query.data?.pages[query.data.pages.length - 1]?.hasOlder ?? false;
  const hasNewerMessages = query.data?.pages[0]?.hasNewer ?? false;

  useEffect(() => {
    if (!query.error || isAbortError(query.error)) return;
    console.error('Failed to fetch messages:', query.error);
    toast.error('Failed to load messages', {
      description: query.error instanceof Error ? query.error.message : 'Check your connection',
    });
  }, [query.error]);

  useEffect(() => {
    if (!query.data || !conversation) return;
    const cached = queryClient
      .getQueryCache()
      .findAll({ queryKey: ['messages', 'conversation'] })
      .filter((entry) => entry.state.data !== undefined)
      .sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt);
    for (const entry of cached.slice(MAX_CACHED_CONVERSATIONS)) {
      if (
        entry.queryHash !== queryClient.getQueryCache().find({ queryKey, exact: true })?.queryHash
      ) {
        queryClient.removeQueries({ queryKey: entry.queryKey, exact: true });
      }
    }
  }, [conversation, query.data, queryClient, queryKey]);

  const fetchOlderMessages = useCallback(async () => {
    if (!conversation || loadingOlderRef.current || !hasOlderMessages) return;
    const oldest = messages[0];
    if (!oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const controller = new AbortController();
    olderControllerRef.current = controller;
    try {
      const fetched = await api.getMessages(
        {
          type: conversation.type === 'channel' ? 'CHAN' : 'PRIV',
          conversation_key: conversation.id,
          limit: MESSAGE_PAGE_SIZE,
          before: oldest.received_at,
          before_id: oldest.id,
        },
        controller.signal
      );
      queryClient.setQueryData<ConversationInfiniteData>(queryKey, (data) => {
        if (!data) return replaceWithSinglePage(fetched, fetched.length >= MESSAGE_PAGE_SIZE);
        return {
          ...data,
          pages: [
            ...data.pages,
            {
              messages: fetched.map(applyPendingAck),
              hasOlder: fetched.length >= MESSAGE_PAGE_SIZE,
              hasNewer: true,
            },
          ],
          pageParams: [
            ...data.pageParams,
            { direction: 'older', receivedAt: oldest.received_at, messageId: oldest.id },
          ],
        };
      });
      setCacheVersion((version) => version + 1);
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error('Failed to load older messages');
      }
    } finally {
      if (olderControllerRef.current === controller) olderControllerRef.current = null;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [applyPendingAck, conversation, hasOlderMessages, messages, queryClient, queryKey]);

  const fetchNewerMessages = useCallback(async () => {
    if (!conversation || loadingNewerRef.current || !hasNewerMessages) return;
    const newest = messages[messages.length - 1];
    if (!newest) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    const controller = new AbortController();
    newerControllerRef.current = controller;
    try {
      const fetched = await api.getMessages(
        {
          type: conversation.type === 'channel' ? 'CHAN' : 'PRIV',
          conversation_key: conversation.id,
          limit: MESSAGE_PAGE_SIZE,
          after: newest.received_at,
          after_id: newest.id,
        },
        controller.signal
      );
      const stillHasNewer = fetched.length >= MESSAGE_PAGE_SIZE;
      queryClient.setQueryData<ConversationInfiniteData>(queryKey, (data) => {
        if (!data) return replaceWithSinglePage(fetched, true, stillHasNewer);
        return {
          ...data,
          pages: [
            {
              messages: fetched.map(applyPendingAck),
              hasOlder: true,
              hasNewer: stillHasNewer,
            },
            ...data.pages,
          ],
          pageParams: [
            { direction: 'newer', receivedAt: newest.received_at, messageId: newest.id },
            ...data.pageParams,
          ],
        };
      });
      setCacheVersion((version) => version + 1);
      if (!stillHasNewer && pendingReconnectRef.current) {
        pendingReconnectRef.current = false;
        queueMicrotask(() => reconcileLatestRef.current());
      }
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error('Failed to load newer messages');
      }
    } finally {
      if (newerControllerRef.current === controller) newerControllerRef.current = null;
      loadingNewerRef.current = false;
      setLoadingNewer(false);
    }
  }, [applyPendingAck, conversation, hasNewerMessages, messages, queryClient, queryKey]);

  const jumpToBottom = useCallback(() => {
    if (!conversation) return;
    pendingReconnectRef.current = false;
    setAnchor({ conversationId: conversation.id, target: null });
    setJumpLoading(true);
    void api
      .getMessages({
        type: conversation.type === 'channel' ? 'CHAN' : 'PRIV',
        conversation_key: conversation.id,
        limit: MESSAGE_PAGE_SIZE,
      })
      .then((fetched) => {
        queryClient.setQueryData(
          queryKey,
          replaceWithSinglePage(fetched.map(applyPendingAck), fetched.length >= MESSAGE_PAGE_SIZE)
        );
        setCacheVersion((version) => version + 1);
      })
      .catch((error) => {
        if (!isAbortError(error)) toast.error('Failed to load latest messages');
      })
      .finally(() => setJumpLoading(false));
  }, [applyPendingAck, conversation, queryClient, queryKey]);

  const reloadCurrentConversation = useCallback(() => {
    if (!conversation) return;
    void queryClient.resetQueries({ queryKey, exact: true });
  }, [conversation, queryClient, queryKey]);

  const observeMessage = useCallback(
    (message: Message): { added: boolean; activeConversation: boolean } => {
      const withAck = applyPendingAck(message);
      const active = isActiveConversationMessage(activeConversationRef.current, withAck);
      const targetKey = queryKeys.conversation(
        messageConversationKind(withAck),
        withAck.conversation_key
      );
      const existing = queryClient.getQueryData<ConversationInfiniteData>(targetKey);
      if (active && hasNewerMessages) return { added: false, activeConversation: true };

      const current = flattenMessages(existing);
      const contentKey = getMessageContentKey(withAck);
      if (
        current.some(
          (candidate) =>
            candidate.id === withAck.id || getMessageContentKey(candidate) === contentKey
        )
      ) {
        return { added: false, activeConversation: active };
      }
      queryClient.setQueryData<ConversationInfiniteData>(targetKey, (data) => {
        if (!data) return replaceWithSinglePage([withAck], true);
        const pages = [...data.pages];
        const index = pages.length - 1;
        pages[index] = { ...pages[index], messages: [...pages[index].messages, withAck] };
        return { ...data, pages };
      });
      setCacheVersion((version) => version + 1);
      return { added: true, activeConversation: active };
    },
    [applyPendingAck, hasNewerMessages, queryClient]
  );

  const receiveMessageAck = useCallback(
    (messageId: number, ackCount: number, paths?: MessagePath[], packetId?: number | null) => {
      let found = false;
      for (const cachedQuery of queryClient
        .getQueryCache()
        .findAll({ queryKey: ['messages', 'conversation'] })) {
        queryClient.setQueryData<ConversationInfiniteData>(cachedQuery.queryKey, (data) =>
          mapQueryMessages(data, (message) => {
            if (message.id !== messageId) return message;
            found = true;
            return {
              ...message,
              acked: Math.max(message.acked, ackCount),
              ...(paths !== undefined && paths.length >= (message.paths?.length ?? 0) && { paths }),
              ...(packetId !== undefined && { packet_id: packetId }),
            };
          })
        );
      }
      if (found) {
        pendingAcksRef.current.delete(messageId);
        setCacheVersion((version) => version + 1);
        return;
      }
      const pending = mergePendingAck(
        pendingAcksRef.current.get(messageId),
        ackCount,
        paths,
        packetId
      );
      pendingAcksRef.current.delete(messageId);
      pendingAcksRef.current.set(messageId, pending);
      if (pendingAcksRef.current.size > MAX_PENDING_ACKS) {
        pendingAcksRef.current.delete(pendingAcksRef.current.keys().next().value as number);
      }
    },
    [queryClient]
  );

  const reconcileLatest = useCallback(() => {
    const current = activeConversationRef.current;
    if (!isMessageConversation(current)) return;
    const requestId = ++reconcileRequestRef.current;
    const key = queryKeys.conversation(conversationKind(current), current.id);
    const idsAtStart = new Set(
      flattenMessages(queryClient.getQueryData<ConversationInfiniteData>(key)).map(
        (message) => message.id
      )
    );
    void api
      .getMessages({
        type: current.type === 'channel' ? 'CHAN' : 'PRIV',
        conversation_key: current.id,
        limit: MESSAGE_PAGE_SIZE,
      })
      .then((fetched) => {
        if (requestId !== reconcileRequestRef.current) return;
        const currentData = queryClient.getQueryData<ConversationInfiniteData>(key);
        const merged = reconcileConversationMessages(
          flattenMessages(currentData),
          fetched.map(applyPendingAck),
          fetched.length >= MESSAGE_PAGE_SIZE,
          idsAtStart
        );
        if (merged) {
          queryClient.setQueryData(
            key,
            replaceWithSinglePage(merged, fetched.length >= MESSAGE_PAGE_SIZE)
          );
          setCacheVersion((version) => version + 1);
        }
      })
      .catch((error) => {
        if (!isAbortError(error)) console.debug('Background reconciliation failed:', error);
      });
  }, [applyPendingAck, queryClient]);

  reconcileLatestRef.current = reconcileLatest;

  const reconcileOnReconnect = useCallback(() => {
    if (hasNewerMessages) {
      pendingReconnectRef.current = true;
      return;
    }
    pendingReconnectRef.current = false;
    reconcileLatest();
  }, [hasNewerMessages, reconcileLatest]);

  const renameConversationMessages = useCallback(
    (oldId: string, newId: string) => {
      for (const kind of ['contact', 'channel'] as const) {
        const oldKey = queryKeys.conversation(kind, oldId);
        const oldData = queryClient.getQueryData<ConversationInfiniteData>(oldKey);
        if (!oldData) continue;
        const newKey = queryKeys.conversation(kind, newId);
        const merged = [
          ...flattenMessages(queryClient.getQueryData<ConversationInfiniteData>(newKey)),
          ...flattenMessages(oldData),
        ];
        queryClient.setQueryData(newKey, replaceWithSinglePage(merged, true));
        queryClient.removeQueries({ queryKey: oldKey, exact: true });
      }
    },
    [queryClient]
  );

  const removeConversationMessages = useCallback(
    (conversationIdToRemove: string) => {
      for (const kind of ['contact', 'channel'] as const) {
        queryClient.removeQueries({
          queryKey: queryKeys.conversation(kind, conversationIdToRemove),
          exact: true,
        });
      }
    },
    [queryClient]
  );

  const clearConversationMessages = useCallback(() => {
    queryClient.removeQueries({ queryKey: ['messages', 'conversation'] });
  }, [queryClient]);

  return {
    messages,
    messagesLoading: conversation !== null && (query.isPending || jumpLoading),
    loadingOlder,
    hasOlderMessages,
    hasNewerMessages,
    loadingNewer,
    fetchOlderMessages,
    fetchNewerMessages,
    jumpToBottom,
    reloadCurrentConversation,
    observeMessage,
    receiveMessageAck,
    reconcileOnReconnect,
    renameConversationMessages,
    removeConversationMessages,
    clearConversationMessages,
  };
}
