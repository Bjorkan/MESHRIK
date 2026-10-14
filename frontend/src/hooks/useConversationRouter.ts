import { useCallback, useEffect, useMemo, type MutableRefObject } from 'react';

import {
  getLastViewedConversation,
  getReopenLastConversationEnabled,
  saveLastViewedConversation,
} from '../utils/lastViewedConversation';
import { findPublicChannel } from '../utils/publicChannel';
import { getContactDisplayName } from '../utils/pubkey';
import type { EntityRoute } from '../routing/entityRoutes';
import type { Channel, Contact, Conversation } from '../types';

function resolvePublicFromChannels(channels: Channel[]): Conversation | null {
  const publicChannel = findPublicChannel(channels);
  return publicChannel
    ? { type: 'channel', id: publicChannel.key, name: publicChannel.name }
    : null;
}

interface UseConversationRouterArgs {
  channels: Channel[];
  channelsLoaded: boolean;
  contacts: Contact[];
  contactsLoaded: boolean;
  setSidebarOpen: (open: boolean) => void;
  pendingDeleteFallbackRef: MutableRefObject<boolean>;
  hasSetDefaultConversation: MutableRefObject<boolean>;
  routeConversation?: Conversation | null;
  routeEntity?: EntityRoute | null;
  routeIsRoot?: boolean;
  onNavigateConversation?: (
    conversation: Conversation,
    options?: { replace?: boolean; targetMessageId?: number | null }
  ) => void;
}

export function useConversationRouter({
  channels,
  channelsLoaded,
  contacts,
  contactsLoaded,
  setSidebarOpen,
  pendingDeleteFallbackRef,
  hasSetDefaultConversation,
  routeConversation,
  routeEntity,
  routeIsRoot,
  onNavigateConversation,
}: UseConversationRouterArgs) {
  const rootConversation = useMemo(() => {
    if (routeEntity || routeConversation || routeIsRoot === false) return null;

    if (getReopenLastConversationEnabled()) {
      const lastViewed = getLastViewedConversation();
      if (
        lastViewed &&
        (lastViewed.type === 'raw' ||
          lastViewed.type === 'map' ||
          lastViewed.type === 'visualizer' ||
          lastViewed.type === 'trace' ||
          lastViewed.type === 'radio-activity')
      ) {
        return lastViewed;
      }
      if (lastViewed?.type === 'channel' && channelsLoaded) {
        const channel = channels.find(
          (candidate) => candidate.key.toLowerCase() === lastViewed.id.toLowerCase()
        );
        if (channel) return { type: 'channel', id: channel.key, name: channel.name } as const;
      }
      if (lastViewed?.type === 'contact' && contactsLoaded) {
        const contact = contacts.find(
          (candidate) => candidate.public_key.toLowerCase() === lastViewed.id.toLowerCase()
        );
        if (contact) {
          return {
            type: 'contact',
            id: contact.public_key,
            name: getContactDisplayName(contact.name, contact.public_key, contact.last_advert),
          } as const;
        }
      }
      if (
        (lastViewed?.type === 'channel' && !channelsLoaded) ||
        (lastViewed?.type === 'contact' && !contactsLoaded)
      ) {
        return null;
      }
    }

    return channelsLoaded ? resolvePublicFromChannels(channels) : null;
  }, [
    channels,
    channelsLoaded,
    contacts,
    contactsLoaded,
    routeConversation,
    routeEntity,
    routeIsRoot,
  ]);
  const activeConversation = routeConversation ?? (routeEntity ? null : rootConversation);

  const setActiveConversation = useCallback(
    (
      conversation: Conversation | null,
      options?: { replace?: boolean; targetMessageId?: number | null }
    ) => {
      const target = conversation ?? resolvePublicFromChannels(channels);
      if (!target) return;
      if (onNavigateConversation) {
        onNavigateConversation(target, options);
      }
    },
    [channels, onNavigateConversation]
  );

  // The root route has no independently writable selected conversation. Once its
  // Query-backed entities settle, replace it with the canonical entity/tool URL.
  useEffect(() => {
    if (routeIsRoot !== true || !rootConversation || !onNavigateConversation) return;
    hasSetDefaultConversation.current = true;
    onNavigateConversation(rootConversation, { replace: true });
  }, [hasSetDefaultConversation, onNavigateConversation, rootConversation, routeIsRoot]);

  useEffect(() => {
    if (activeConversation && activeConversation.type !== 'search') {
      saveLastViewedConversation(activeConversation);
    }
  }, [activeConversation]);

  pendingDeleteFallbackRef.current = false;

  const handleSelectConversation = useCallback(
    (
      conversation: Conversation,
      options?: { replace?: boolean; targetMessageId?: number | null }
    ) => {
      setActiveConversation(conversation, options);
      setSidebarOpen(false);
    },
    [setActiveConversation, setSidebarOpen]
  );

  return {
    activeConversation,
    setActiveConversation,
    handleSelectConversation,
  };
}
