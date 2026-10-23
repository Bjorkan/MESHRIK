import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDebouncer } from '@tanstack/react-pacer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api';
import { toast } from '../components/ui/sonner';
import { queryKeys } from '../queryClient';
import { getStateKey, type ConversationTimes } from '../utils/conversationState';
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
    last_message_times: {},
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
  unreadsResolved: boolean;
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
  useLingui();

  const queryClient = useQueryClient();
  const mutationVersionRef = useRef(0);
  const pendingMarkAllCountRef = useRef(0);
  const markAllNeedsReconcileRef = useRef(false);
  const activeConversationRef = useRef(activeConversation);
  activeConversationRef.current = activeConversation;
  const pendingReadBoundaryRef = useRef<PendingReadBoundary | null>(null);

  const unreadQuery = useQuery<UnreadCounts>({
    queryKey: queryKeys.unreads(),
    queryFn: async ({ signal }) => {
      const versionAtStart = mutationVersionRef.current;
      const serverSnapshot = await api.getUnreads(signal);
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
    const boundary = pendingReadBoundaryRef.current;
    pendingReadBoundaryRef.current = null;
    if (boundary) markRead(boundary);
  }, [markRead]);
  const activeReadDebouncer = useDebouncer(flushPendingRead, {
    key: 'active-conversation-read-boundary',
    wait: ACTIVE_READ_DEBOUNCE_MS,
    onUnmount: (debouncer) => debouncer.flush(),
  });

  const scheduleReadBoundary = useCallback(
    (boundary: PendingReadBoundary) => {
      const pending = pendingReadBoundaryRef.current;
      if (pending && (pending.type !== boundary.type || pending.id !== boundary.id)) {
        activeReadDebouncer.cancel();
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
      activeReadDebouncer.maybeExecute();
    },
    [activeReadDebouncer, flushPendingRead]
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
    if (!isUnreadTrackedConversation(activeConversation)) {
      return () => activeReadDebouncer.flush();
    }
    markRead({ type: activeConversation.type, id: activeConversation.id });
    return () => activeReadDebouncer.flush();
  }, [activeConversation, activeReadDebouncer, markRead]);

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
      pendingMarkAllCountRef.current += 1;
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
        // A newer mutation or WebSocket update owns the cache now. Reconcile
        // only after every concurrent bulk mutation settles; refetching while
        // a newer mark-all is still in flight can resurrect stale badges.
        markAllNeedsReconcileRef.current = true;
      }
      toast.error(t`Failed to mark all messages as read`, {
        description: error instanceof Error ? error.message : t`Check your connection and retry`,
      });
    },
    onSettled: () => {
      pendingMarkAllCountRef.current = Math.max(0, pendingMarkAllCountRef.current - 1);
      if (pendingMarkAllCountRef.current === 0 && markAllNeedsReconcileRef.current) {
        markAllNeedsReconcileRef.current = false;
        void queryClient.invalidateQueries({ queryKey: queryKeys.unreads() });
      }
    },
  });

  return {
    unreadCounts,
    mentions,
    lastMessageTimes: snapshot.last_message_times,
    unreadLastReadAts: snapshot.last_read_ats,
    firstUnreadIds: snapshot.first_unread_ids,
    unreadsResolved: !unreadQuery.isPlaceholderData,
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
