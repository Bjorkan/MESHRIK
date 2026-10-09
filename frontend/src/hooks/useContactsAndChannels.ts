import {
  useState,
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { takePrefetchOrFetch } from '../prefetch';
import { queryKeys } from '../queryClient';
import { toast } from '../components/ui/sonner';
import { getContactDisplayName } from '../utils/pubkey';
import { findPublicChannel, PUBLIC_CHANNEL_KEY, PUBLIC_CHANNEL_NAME } from '../utils/publicChannel';
import type { BulkCreateHashtagChannelsResult, Channel, Contact, Conversation } from '../types';

interface UseContactsAndChannelsArgs {
  setActiveConversation: (conv: Conversation | null) => void;
  pendingDeleteFallbackRef: MutableRefObject<boolean>;
  hasSetDefaultConversation: MutableRefObject<boolean>;
  removeConversationMessages: (conversationId: string) => void;
}

function applyStateAction<T>(previous: T, update: SetStateAction<T>): T {
  return typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
}

/** Fetch all contacts, preserving the early first-page prefetch and paginating beyond it. */
export async function fetchAllContacts(signal?: AbortSignal): Promise<Contact[]> {
  const pageSize = 1000;
  const first = await takePrefetchOrFetch('contacts', () => api.getContacts(pageSize, 0, signal));
  if (first.length < pageSize) return first;
  let all = [...first];
  let offset = pageSize;
  while (true) {
    const page = await api.getContacts(pageSize, offset, signal);
    all = all.concat(page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

export function useContactsAndChannels({
  setActiveConversation,
  pendingDeleteFallbackRef,
  hasSetDefaultConversation,
  removeConversationMessages,
}: UseContactsAndChannelsArgs) {
  const queryClient = useQueryClient();
  const [undecryptedCount, setUndecryptedCount] = useState(0);

  const contactsQuery = useQuery({
    queryKey: queryKeys.contacts(),
    queryFn: ({ signal }) => fetchAllContacts(signal),
  });
  const channelsQuery = useQuery({
    queryKey: queryKeys.channels(),
    queryFn: ({ signal }) => takePrefetchOrFetch('channels', () => api.getChannels(signal)),
  });

  const contacts = contactsQuery.data ?? [];
  const contactsLoaded = !contactsQuery.isPending;
  const channels = channelsQuery.data ?? [];

  useEffect(() => {
    if (contactsQuery.error) {
      console.error('Failed to fetch contacts:', contactsQuery.error);
    }
  }, [contactsQuery.error]);

  useEffect(() => {
    if (channelsQuery.error) {
      console.error('Failed to fetch channels:', channelsQuery.error);
    }
  }, [channelsQuery.error]);

  const setContacts: Dispatch<SetStateAction<Contact[]>> = useCallback(
    (update) => {
      // Cancellation prevents an older HTTP response from overwriting a newer WS event.
      void queryClient.cancelQueries({ queryKey: queryKeys.contacts() });
      queryClient.setQueryData<Contact[]>(queryKeys.contacts(), (previous = []) =>
        applyStateAction(previous, update)
      );
    },
    [queryClient]
  );

  const setChannels: Dispatch<SetStateAction<Channel[]>> = useCallback(
    (update) => {
      void queryClient.cancelQueries({ queryKey: queryKeys.channels() });
      queryClient.setQueryData<Channel[]>(queryKeys.channels(), (previous = []) =>
        applyStateAction(previous, update)
      );
    },
    [queryClient]
  );

  const refreshContacts = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.contacts() }),
    [queryClient]
  );
  const refreshChannels = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.channels() }),
    [queryClient]
  );

  const fetchUndecryptedCountInternal = useCallback(async () => {
    try {
      const data = await takePrefetchOrFetch('undecryptedCount', api.getUndecryptedPacketCount);
      setUndecryptedCount(data.count);
    } catch (err) {
      console.error('Failed to fetch undecrypted count:', err);
    }
  }, []);

  const handleCreateContact = useCallback(
    async (name: string, publicKey: string, tryHistorical: boolean, type?: number) => {
      const created = await api.createContact(publicKey, name || undefined, tryHistorical, type);
      await refreshContacts();

      setActiveConversation({
        type: 'contact',
        id: created.public_key,
        name: getContactDisplayName(created.name, created.public_key, created.last_advert),
      });
    },
    [refreshContacts, setActiveConversation]
  );

  const handleCreateChannel = useCallback(
    async (name: string, key: string, tryHistorical: boolean) => {
      const created = await api.createChannel(name, key);
      await refreshChannels();

      setActiveConversation({
        type: 'channel',
        id: created.key,
        name,
      });

      if (tryHistorical) {
        await api.decryptHistoricalPackets({
          key_type: 'channel',
          channel_key: created.key,
        });
        fetchUndecryptedCountInternal();
      }
    },
    [fetchUndecryptedCountInternal, refreshChannels, setActiveConversation]
  );

  const handleCreateHashtagChannel = useCallback(
    async (name: string, tryHistorical: boolean) => {
      const channelName = name.startsWith('#') ? name : `#${name}`;

      const created = await api.createChannel(channelName);
      await refreshChannels();

      setActiveConversation({
        type: 'channel',
        id: created.key,
        name: channelName,
      });

      if (tryHistorical) {
        await api.decryptHistoricalPackets({
          key_type: 'channel',
          channel_name: channelName,
        });
        fetchUndecryptedCountInternal();
      }
    },
    [fetchUndecryptedCountInternal, refreshChannels, setActiveConversation]
  );

  const handleBulkCreateHashtagChannels = useCallback(
    async (
      channelNames: string[],
      tryHistorical: boolean
    ): Promise<BulkCreateHashtagChannelsResult> => {
      const result = await api.bulkCreateHashtagChannels(channelNames, tryHistorical);
      await refreshChannels();

      if (tryHistorical && result.decrypt_started) {
        fetchUndecryptedCountInternal();
      }

      return result;
    },
    [fetchUndecryptedCountInternal, refreshChannels]
  );

  const handleDeleteChannel = useCallback(
    async (key: string) => {
      if (!confirm('Delete this channel? Message history will be preserved.')) return;
      try {
        pendingDeleteFallbackRef.current = true;
        await api.deleteChannel(key);
        removeConversationMessages(key);
        const refreshedChannels = await api.getChannels();
        setChannels(refreshedChannels);
        const publicChannel = findPublicChannel(refreshedChannels);
        hasSetDefaultConversation.current = true;
        setActiveConversation({
          type: 'channel',
          id: publicChannel?.key || PUBLIC_CHANNEL_KEY,
          name: publicChannel?.name || PUBLIC_CHANNEL_NAME,
        });
        toast.success('Channel deleted');
      } catch (err) {
        console.error('Failed to delete channel:', err);
        toast.error('Failed to delete channel', {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [
      hasSetDefaultConversation,
      pendingDeleteFallbackRef,
      removeConversationMessages,
      setActiveConversation,
      setChannels,
    ]
  );

  const handleDeleteContact = useCallback(
    async (publicKey: string) => {
      if (!confirm('Delete this contact? Message history will be preserved.')) return;
      try {
        pendingDeleteFallbackRef.current = true;
        const deleteResult = await api.deleteContact(publicKey);
        removeConversationMessages(publicKey);
        setContacts((prev) => prev.filter((c) => c.public_key !== publicKey));
        const refreshedChannels = await api.getChannels();
        setChannels(refreshedChannels);
        const publicChannel = findPublicChannel(refreshedChannels);
        hasSetDefaultConversation.current = true;
        setActiveConversation({
          type: 'channel',
          id: publicChannel?.key || PUBLIC_CHANNEL_KEY,
          name: publicChannel?.name || PUBLIC_CHANNEL_NAME,
        });
        if (deleteResult.status === 'partial') {
          toast.warning('Contact deleted from MESHRIK, but not from the radio', {
            description: deleteResult.radio_error ?? undefined,
          });
        } else {
          toast.success('Contact deleted');
        }
      } catch (err) {
        console.error('Failed to delete contact:', err);
        toast.error('Failed to delete contact', {
          description: err instanceof Error ? err.message : undefined,
        });
      }
    },
    [
      hasSetDefaultConversation,
      pendingDeleteFallbackRef,
      removeConversationMessages,
      setActiveConversation,
      setChannels,
      setContacts,
    ]
  );

  return {
    contacts,
    contactsLoaded,
    channels,
    undecryptedCount,
    setContacts,
    setChannels,
    refreshContacts,
    refreshChannels,
    fetchUndecryptedCount: fetchUndecryptedCountInternal,
    handleCreateContact,
    handleCreateChannel,
    handleCreateHashtagChannel,
    handleBulkCreateHashtagChannels,
    handleDeleteChannel,
    handleDeleteContact,
  };
}
