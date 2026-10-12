import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api';
import { toast } from '../components/ui/sonner';
import { queryKeys } from '../queryClient';
import {
  getLastMessageTimes,
  getStateKey,
  renameConversationTimeKey,
  setLastMessageTime,
  type ConversationTimes,
} from '../utils/conversationState';
import type { Channel, Contact, Conversation, Message, UnreadCounts } from '../types';

type UnreadTrackedConversation = Conversation & { type: 'channel' | 'contact' };
type PendingReadBoundary = {
  type: 'channel' | 'contact';
  id: string;
  messageId: number;
  receivedAt: number;
};
type MarkReadRequest = Pick<PendingReadBoundary, 'type' | 'id'> & { messageId?: number };

const ACTIVE_READ_DEBOUNCE_MS = 250;

function emptyUnreadCounts(): UnreadCounts {
  return {
    counts: {},
    mentions: {},
    last_message_times: getLastMessageTimes(),
    last_read_ats: {},
    first_unread_ids: {},
  };
}

function isUnreadTrackedConversation(
  conversation: Conversation | null
): conversation is UnreadTrackedConversation {
  return conversation?.type === 'channel' || conversation?.type === 'contact';
}

function removeKey<T>(values: Record<string, T>, key: string): Record<string, T> {
  if (!(key in values)) return values;
  const next = { ...values };
  delete next[key];
  return next;
}

function renameKey<T>(
  values: Record<string, T>,
  oldKey: string,
  newKey: string
): Record<string, T> {
  if (!(oldKey in values)) return values;
  const next = { ...values };
  next[newKey] ??= next[oldKey];
  delete next[oldKey];
  return next;
}

interface UseUnreadCountsResult {
  unreadCounts: Record<string, number>;
  mentions: Record<string, boolean>;
  lastMessageTimes: ConversationTimes;
  unreadLastReadAts: Record<string, number | null>;
  firstUnreadIds: Record<string, number | null>;
  recordMessageEvent: (args: {
    msg: Message;
    activeConversation: boolean;
    isNewMessage: boolean;
    hasMention?: boolean;
  }) => void;
  renameConversationState: (oldStateKey: string, newStateKey: string) => void;
  removeConversationState: (stateKey: string) => void;
  markAllRead: () => Promise<void>;
  refreshUnreads: () => Promise<void>;
}

export function useUnreadCounts(
  channels: Channel[],
  contacts: Contact[],
  activeConversation: Conversation | null
): UseUnreadCountsResult {
  const queryClient = useQueryClient();
  const mutationVersionRef = useRef(0);
  const activeConversationRef = useRef(activeConversation);
  activeConversationRef.current = activeConversation;
  const pendingReadBoundaryRef = useRef<PendingReadBoundary | null>(null);
  const pendingReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const unreadQuery = useQuery({
    queryKey: queryKeys.unreads(),
    queryFn: async () => {
      const versionAtStart = mutationVersionRef.current;
      const serverSnapshot = await api.getUnreads();
      if (versionAtStart !== mutationVersionRef.current) {
        return queryClient.getQueryData<UnreadCounts>(queryKeys.unreads()) ?? serverSnapshot;
      }
      return serverSnapshot;
    },
    placeholderData: emptyUnreadCounts,
  });

  const snapshot = unreadQuery.data ?? emptyUnreadCounts();
  const activeStateKey = isUnreadTrackedConversation(activeConversation)
    ? getStateKey(activeConversation.type, activeConversation.id)
    : null;
  const unreadCounts = useMemo(
    () => (activeStateKey ? removeKey(snapshot.counts, activeStateKey) : snapshot.counts),
    [activeStateKey, snapshot.counts]
  );
  const mentions = useMemo(
    () => (activeStateKey ? removeKey(snapshot.mentions, activeStateKey) : snapshot.mentions),
    [activeStateKey, snapshot.mentions]
  );

  useEffect(() => {
    for (const [key, timestamp] of Object.entries(snapshot.last_message_times)) {
      setLastMessageTime(key, timestamp);
    }
  }, [snapshot.last_message_times]);

  const { mutate: markRead } = useMutation({
    mutationFn: async (boundary: MarkReadRequest): Promise<void> => {
      if (boundary.type === 'channel') {
        await (boundary.messageId === undefined
          ? api.markChannelRead(boundary.id)
          : api.markChannelRead(boundary.id, boundary.messageId));
      } else {
        await (boundary.messageId === undefined
          ? api.markContactRead(boundary.id)
          : api.markContactRead(boundary.id, boundary.messageId));
      }
    },
    onError: (error, boundary) => {
      console.error(`Failed to mark active ${boundary.type} as read on server:`, error);
    },
  });

  const flushPendingRead = useCallback(() => {
    if (pendingReadTimerRef.current !== null) {
      clearTimeout(pendingReadTimerRef.current);
      pendingReadTimerRef.current = null;
    }
    const boundary = pendingReadBoundaryRef.current;
    pendingReadBoundaryRef.current = null;
    if (boundary) markRead(boundary);
  }, [markRead]);

  const scheduleReadBoundary = useCallback(
    (boundary: PendingReadBoundary) => {
      const pending = pendingReadBoundaryRef.current;
      if (pending && (pending.type !== boundary.type || pending.id !== boundary.id)) {
        flushPendingRead();
      }
      const current = pendingReadBoundaryRef.current;
      if (
        !current ||
        boundary.receivedAt > current.receivedAt ||
        (boundary.receivedAt === current.receivedAt && boundary.messageId > current.messageId)
      ) {
        pendingReadBoundaryRef.current = boundary;
      }
      if (pendingReadTimerRef.current !== null) clearTimeout(pendingReadTimerRef.current);
      pendingReadTimerRef.current = setTimeout(flushPendingRead, ACTIVE_READ_DEBOUNCE_MS);
    },
    [flushPendingRead]
  );

  const updateSnapshot = useCallback(
    (update: (previous: UnreadCounts) => UnreadCounts) => {
      mutationVersionRef.current += 1;
      queryClient.setQueryData<UnreadCounts>(queryKeys.unreads(), (previous) =>
        update(previous ?? emptyUnreadCounts())
      );
    },
    [queryClient]
  );

  useEffect(() => {
    if (!isUnreadTrackedConversation(activeConversation)) return flushPendingRead;
    markRead({ type: activeConversation.type, id: activeConversation.id });
    return flushPendingRead;
  }, [activeConversation, flushPendingRead, markRead]);

  const channelsLen = channels.length;
  const contactsLen = contacts.length;
  const observedEntityCountsRef = useRef(false);
  useEffect(() => {
    if (!observedEntityCountsRef.current) {
      observedEntityCountsRef.current = true;
      return;
    }
    void unreadQuery.refetch();
    // Query observer identity is not an input; entity cardinality is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsLen, contactsLen]);

  const recordMessageEvent = useCallback(
    ({
      msg,
      activeConversation: isActiveConversation,
      isNewMessage,
      hasMention,
    }: {
      msg: Message;
      activeConversation: boolean;
      isNewMessage: boolean;
      hasMention?: boolean;
    }) => {
      const stateKey =
        msg.type === 'CHAN'
          ? getStateKey('channel', msg.conversation_key)
          : msg.type === 'PRIV'
            ? getStateKey('contact', msg.conversation_key)
            : null;
      if (!stateKey) return;

      const timestamp = msg.received_at || Math.floor(Date.now() / 1000);
      setLastMessageTime(stateKey, timestamp);
      updateSnapshot((previous) => {
        const next: UnreadCounts = {
          ...previous,
          counts: { ...previous.counts },
          mentions: { ...previous.mentions },
          last_message_times: { ...previous.last_message_times, [stateKey]: timestamp },
          first_unread_ids: { ...previous.first_unread_ids },
        };
        if (isActiveConversation) {
          delete next.counts[stateKey];
          delete next.mentions[stateKey];
        } else if (!msg.outgoing && isNewMessage) {
          next.counts[stateKey] = (next.counts[stateKey] ?? 0) + 1;
          next.first_unread_ids[stateKey] ??= msg.id;
          if (hasMention) next.mentions[stateKey] = true;
        }
        return next;
      });

      if (isActiveConversation && !msg.outgoing && isNewMessage) {
        scheduleReadBoundary({
          type: msg.type === 'CHAN' ? 'channel' : 'contact',
          id: msg.conversation_key,
          messageId: msg.id,
          receivedAt: timestamp,
        });
      }
    },
    [scheduleReadBoundary, updateSnapshot]
  );

  const renameConversationState = useCallback(
    (oldStateKey: string, newStateKey: string) => {
      if (oldStateKey === newStateKey) return;
      renameConversationTimeKey(oldStateKey, newStateKey);
      updateSnapshot((previous) => ({
        ...previous,
        counts: renameKey(previous.counts, oldStateKey, newStateKey),
        mentions: renameKey(previous.mentions, oldStateKey, newStateKey),
        last_message_times: renameKey(previous.last_message_times, oldStateKey, newStateKey),
        last_read_ats: renameKey(previous.last_read_ats, oldStateKey, newStateKey),
        first_unread_ids: renameKey(previous.first_unread_ids, oldStateKey, newStateKey),
      }));
    },
    [updateSnapshot]
  );

  const removeConversationState = useCallback(
    (stateKey: string) => {
      updateSnapshot((previous) => ({
        ...previous,
        counts: removeKey(previous.counts, stateKey),
        mentions: removeKey(previous.mentions, stateKey),
        last_message_times: removeKey(previous.last_message_times, stateKey),
        last_read_ats: removeKey(previous.last_read_ats, stateKey),
        first_unread_ids: removeKey(previous.first_unread_ids, stateKey),
      }));
    },
    [updateSnapshot]
  );

  const markAllMutation = useMutation({
    mutationFn: api.markAllRead,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.unreads() });
      const previous = queryClient.getQueryData<UnreadCounts>(queryKeys.unreads());
      mutationVersionRef.current += 1;
      const version = mutationVersionRef.current;
      queryClient.setQueryData<UnreadCounts>(queryKeys.unreads(), (current) => ({
        ...(current ?? emptyUnreadCounts()),
        counts: {},
        mentions: {},
        last_read_ats: {},
        first_unread_ids: {},
      }));
      return { previous, version };
    },
    onError: (error, _variables, context) => {
      if (context?.previous && context.version === mutationVersionRef.current) {
        queryClient.setQueryData(queryKeys.unreads(), context.previous);
      } else {
        void queryClient.invalidateQueries({ queryKey: queryKeys.unreads() });
      }
      toast.error('Failed to mark all messages as read', {
        description: error instanceof Error ? error.message : 'Check your connection and retry',
      });
    },
  });

  return {
    unreadCounts,
    mentions,
    lastMessageTimes: snapshot.last_message_times,
    unreadLastReadAts: snapshot.last_read_ats,
    firstUnreadIds: snapshot.first_unread_ids,
    recordMessageEvent,
    renameConversationState,
    removeConversationState,
    markAllRead: async () => {
      await markAllMutation.mutateAsync();
    },
    refreshUnreads: async () => {
      await unreadQuery.refetch();
      const active = activeConversationRef.current;
      if (isUnreadTrackedConversation(active)) {
        markRead({ type: active.type, id: active.id });
      }
    },
  };
}
