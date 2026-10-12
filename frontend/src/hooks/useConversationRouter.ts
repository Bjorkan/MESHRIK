import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

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
  onNavigateConversation?: (conversation: Conversation, options?: { replace?: boolean }) => void;
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
  const [storedConversation, setStoredConversation] = useState<Conversation | null>(
    routeConversation ?? null
  );
  const routeOwnsConversation = Boolean(routeConversation || routeEntity);
  const activeConversation = routeOwnsConversation
    ? (routeConversation ?? null)
    : storedConversation;
  const activeConversationRef = useRef<Conversation | null>(activeConversation);
  const previousRouteIsRootRef = useRef(routeIsRoot);

  const setActiveConversation = useCallback(
    (conversation: Conversation | null, options?: { replace?: boolean }) => {
      if (conversation) onNavigateConversation?.(conversation, options);
      setStoredConversation(conversation);
    },
    [onNavigateConversation]
  );

  const getPublicChannelConversation = useCallback(
    (): Conversation | null => resolvePublicFromChannels(channels),
    [channels]
  );

  // Route-backed tools and entities are authoritative. Keep a copy only so the
  // underlying conversation remains available while a settings route is open.
  useEffect(() => {
    if (!routeConversation) return;
    hasSetDefaultConversation.current = true;
    setStoredConversation((current) =>
      current?.type === routeConversation.type &&
      current.id === routeConversation.id &&
      current.mapFocusKey === routeConversation.mapFocusKey
        ? current
        : routeConversation
    );
  }, [hasSetDefaultConversation, routeConversation]);

  // Returning explicitly to `/` means the normal Public/default experience.
  useEffect(() => {
    const enteredRoot = routeIsRoot === true && previousRouteIsRootRef.current === false;
    previousRouteIsRootRef.current = routeIsRoot;
    if (!enteredRoot) return;

    const publicConversation = getPublicChannelConversation();
    if (!publicConversation) return;
    hasSetDefaultConversation.current = true;
    setStoredConversation(publicConversation);
  }, [getPublicChannelConversation, hasSetDefaultConversation, routeIsRoot]);

  // Resolve startup/default behavior only at `/` (or in standalone hook tests).
  useEffect(() => {
    if (routeEntity || routeConversation || routeIsRoot === false) return;
    if (hasSetDefaultConversation.current || storedConversation) return;

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
        setActiveConversation(lastViewed, { replace: true });
        hasSetDefaultConversation.current = true;
        return;
      }

      if (lastViewed?.type === 'channel') {
        if (!channelsLoaded) return;
        const channel = channels.find(
          (candidate) => candidate.key.toLowerCase() === lastViewed.id.toLowerCase()
        );
        if (channel) {
          setActiveConversation(
            { type: 'channel', id: channel.key, name: channel.name },
            { replace: true }
          );
          hasSetDefaultConversation.current = true;
          return;
        }
      }
      if (lastViewed?.type === 'contact') return;
    }

    if (!channelsLoaded) return;
    const publicConversation = getPublicChannelConversation();
    if (publicConversation) {
      setStoredConversation(publicConversation);
      hasSetDefaultConversation.current = true;
    }
  }, [
    channels,
    channelsLoaded,
    getPublicChannelConversation,
    hasSetDefaultConversation,
    routeConversation,
    routeEntity,
    routeIsRoot,
    setActiveConversation,
    storedConversation,
  ]);

  // A saved contact can only be resolved after the contacts query settles.
  useEffect(() => {
    if (routeEntity || routeConversation || routeIsRoot === false) return;
    if (hasSetDefaultConversation.current || storedConversation) return;
    if (!getReopenLastConversationEnabled()) return;

    const lastViewed = getLastViewedConversation();
    if (lastViewed?.type !== 'contact' || !contactsLoaded) return;

    const contact = contacts.find(
      (candidate) => candidate.public_key.toLowerCase() === lastViewed.id.toLowerCase()
    );
    if (contact) {
      setActiveConversation(
        {
          type: 'contact',
          id: contact.public_key,
          name: getContactDisplayName(contact.name, contact.public_key, contact.last_advert),
        },
        { replace: true }
      );
      hasSetDefaultConversation.current = true;
      return;
    }

    if (!channelsLoaded) return;
    const publicConversation = getPublicChannelConversation();
    if (publicConversation) {
      setStoredConversation(publicConversation);
      hasSetDefaultConversation.current = true;
    }
  }, [
    contacts,
    contactsLoaded,
    channelsLoaded,
    getPublicChannelConversation,
    hasSetDefaultConversation,
    routeConversation,
    routeEntity,
    routeIsRoot,
    setActiveConversation,
    storedConversation,
  ]);

  useEffect(() => {
    activeConversationRef.current = activeConversation;
    if (activeConversation && activeConversation.type !== 'search') {
      saveLastViewedConversation(activeConversation);
    }
  }, [activeConversation]);

  // If a delete action left us without an active conversation, recover to Public.
  useEffect(() => {
    if (!pendingDeleteFallbackRef.current) return;
    if (activeConversation) {
      pendingDeleteFallbackRef.current = false;
      return;
    }

    const publicChannel = findPublicChannel(channels);
    if (!publicChannel) return;

    hasSetDefaultConversation.current = true;
    pendingDeleteFallbackRef.current = false;
    setActiveConversation({
      type: 'channel',
      id: publicChannel.key,
      name: publicChannel.name,
    });
  }, [
    activeConversation,
    channels,
    hasSetDefaultConversation,
    pendingDeleteFallbackRef,
    setActiveConversation,
  ]);

  const handleSelectConversation = useCallback(
    (conversation: Conversation) => {
      setActiveConversation(conversation);
      setSidebarOpen(false);
    },
    [setActiveConversation, setSidebarOpen]
  );

  return {
    activeConversation,
    setActiveConversation,
    activeConversationRef,
    handleSelectConversation,
  };
}
