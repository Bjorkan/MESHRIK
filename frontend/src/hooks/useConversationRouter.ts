import { useState, useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import {
  parseHashConversation,
  updateUrlHash,
  pushUrlHash,
  resolveChannelFromHashToken,
  resolveContactFromHashToken,
} from '../utils/urlHash';
import {
  getLastViewedConversation,
  getReopenLastConversationEnabled,
  saveLastViewedConversation,
} from '../utils/lastViewedConversation';
import { findPublicChannel } from '../utils/publicChannel';
import { getContactDisplayName } from '../utils/pubkey';
import { toast } from '../components/ui/sonner';
import type { Channel, Contact, Conversation } from '../types';

function resolvePublicFromChannels(channels: Channel[]): Conversation | null {
  const publicChannel = findPublicChannel(channels);
  return publicChannel
    ? { type: 'channel', id: publicChannel.key, name: publicChannel.name }
    : null;
}

function resolveConversationFromHash(
  channels: Channel[],
  contacts: Contact[]
): Conversation | null {
  const hashConv = parseHashConversation();
  if (!hashConv) return null;

  switch (hashConv.type) {
    case 'channel': {
      const channel = resolveChannelFromHashToken(hashConv.name, channels);
      return channel ? { type: 'channel', id: channel.key, name: channel.name } : null;
    }
    case 'contact': {
      const contact = resolveContactFromHashToken(hashConv.name, contacts);
      return contact
        ? {
            type: 'contact',
            id: contact.public_key,
            name: getContactDisplayName(contact.name, contact.public_key, contact.last_advert),
          }
        : null;
    }
    default:
      return null;
  }
}

interface UseConversationRouterArgs {
  channels: Channel[];
  contacts: Contact[];
  contactsLoaded: boolean;
  suspendHashSync: boolean;
  setSidebarOpen: (open: boolean) => void;
  pendingDeleteFallbackRef: MutableRefObject<boolean>;
  hasSetDefaultConversation: MutableRefObject<boolean>;
  routeConversation?: Conversation | null;
  onNavigateConversation?: (conversation: Conversation) => void;
}

export function useConversationRouter({
  channels,
  contacts,
  contactsLoaded,
  suspendHashSync,
  setSidebarOpen,
  pendingDeleteFallbackRef,
  hasSetDefaultConversation,
  routeConversation,
  onNavigateConversation,
}: UseConversationRouterArgs) {
  const [activeConversation, setActiveConversationState] = useState<Conversation | null>(
    routeConversation ?? null
  );
  const activeConversationRef = useRef<Conversation | null>(null);
  const hashSyncEnabledRef = useRef(
    typeof window !== 'undefined' ? window.location.hash.length > 0 : false
  );
  const shouldPushHistoryRef = useRef(false);
  const isHandlingPopstateRef = useRef(false);
  const channelsRef = useRef(channels);
  const contactsRef = useRef(contacts);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);
  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  const setActiveConversation = useCallback(
    (conv: Conversation | null) => {
      if (conv && onNavigateConversation) {
        onNavigateConversation(conv);
      } else {
        hashSyncEnabledRef.current = true;
        shouldPushHistoryRef.current = true;
      }
      setActiveConversationState(conv);
    },
    [onNavigateConversation]
  );

  const getPublicChannelConversation = useCallback(
    (): Conversation | null => resolvePublicFromChannels(channels),
    [channels]
  );

  useEffect(() => {
    if (routeConversation === undefined) return;
    if (routeConversation) {
      hasSetDefaultConversation.current = true;
      setActiveConversationState((current) =>
        current?.type === routeConversation.type &&
        current.id === routeConversation.id &&
        current.mapFocusKey === routeConversation.mapFocusKey
          ? current
          : routeConversation
      );
      return;
    }

    if (
      activeConversation &&
      activeConversation.type !== 'channel' &&
      activeConversation.type !== 'contact' &&
      window.location.hash.length === 0
    ) {
      const publicConversation = getPublicChannelConversation();
      if (publicConversation) setActiveConversationState(publicConversation);
    }
  }, [
    activeConversation,
    getPublicChannelConversation,
    hasSetDefaultConversation,
    routeConversation,
  ]);

  // Phase 1: Set initial conversation from URL hash or default to Public channel
  // Only needs channels (fast path) - doesn't wait for contacts
  useEffect(() => {
    if (hasSetDefaultConversation.current || activeConversation) return;
    if (routeConversation) return;

    const hashConv = parseHashConversation();

    // No hash: optionally restore last-viewed non-data conversation if enabled on this device.
    if (!hashConv && getReopenLastConversationEnabled()) {
      const lastViewed = getLastViewedConversation();
      if (
        lastViewed &&
        (lastViewed.type === 'raw' ||
          lastViewed.type === 'map' ||
          lastViewed.type === 'visualizer' ||
          lastViewed.type === 'trace' ||
          lastViewed.type === 'radio-activity')
      ) {
        if (onNavigateConversation) {
          onNavigateConversation(lastViewed);
        } else {
          setActiveConversationState(lastViewed);
        }
        hasSetDefaultConversation.current = true;
        return;
      }
    }

    if (channels.length === 0) return;

    // Handle channel hash (ID-first with legacy-name fallback)
    if (hashConv?.type === 'channel') {
      const channel = resolveChannelFromHashToken(hashConv.name, channels);
      if (channel) {
        setActiveConversationState({ type: 'channel', id: channel.key, name: channel.name });
        hasSetDefaultConversation.current = true;
        return;
      }
    }

    // Contact hash — wait for phase 2
    if (hashConv?.type === 'contact') return;

    // No hash: optionally restore last-viewed conversation if enabled on this device.
    if (!hashConv && getReopenLastConversationEnabled()) {
      const lastViewed = getLastViewedConversation();
      if (lastViewed?.type === 'channel') {
        const channel =
          channels.find((c) => c.key.toLowerCase() === lastViewed.id.toLowerCase()) ||
          resolveChannelFromHashToken(lastViewed.id, channels);
        if (channel) {
          setActiveConversationState({
            type: 'channel',
            id: channel.key,
            name: channel.name,
          });
          hasSetDefaultConversation.current = true;
          return;
        }
      }
      // Last-viewed contact resolution waits for contacts in phase 2.
      if (lastViewed?.type === 'contact') return;
    }

    // No hash or unresolvable — default to Public
    const publicConversation = getPublicChannelConversation();
    if (publicConversation) {
      if (hashConv?.type === 'channel') {
        const token =
          hashConv.name.length > 16 ? hashConv.name.substring(0, 16) + '…' : hashConv.name;
        toast.error(`Channel not found: ${token}`);
      }
      setActiveConversationState(publicConversation);
      hasSetDefaultConversation.current = true;
    }
  }, [
    channels,
    activeConversation,
    getPublicChannelConversation,
    hasSetDefaultConversation,
    onNavigateConversation,
    routeConversation,
  ]);

  // Phase 2: Resolve contact hash (only if phase 1 didn't set a conversation)
  useEffect(() => {
    if (hasSetDefaultConversation.current || activeConversation) return;
    if (routeConversation) return;

    const hashConv = parseHashConversation();
    if (hashConv?.type === 'contact') {
      if (!contactsLoaded) return;

      const contact = resolveContactFromHashToken(hashConv.name, contacts);
      if (contact) {
        setActiveConversationState({
          type: 'contact',
          id: contact.public_key,
          name: getContactDisplayName(contact.name, contact.public_key, contact.last_advert),
        });
        hasSetDefaultConversation.current = true;
        return;
      }

      // Contact hash didn't match — fall back to Public if channels loaded.
      const token =
        hashConv.name.length > 16 ? hashConv.name.substring(0, 16) + '…' : hashConv.name;
      toast.error(`Contact not found: ${token}`);
      const publicConversation = getPublicChannelConversation();
      if (publicConversation) {
        setActiveConversationState(publicConversation);
        hasSetDefaultConversation.current = true;
      }
      return;
    }

    // No hash: optionally restore a last-viewed contact once contacts are loaded.
    if (!hashConv && getReopenLastConversationEnabled()) {
      const lastViewed = getLastViewedConversation();
      if (lastViewed?.type !== 'contact') return;
      if (!contactsLoaded) return;

      const contact =
        contacts.find((item) => item.public_key.toLowerCase() === lastViewed.id.toLowerCase()) ||
        resolveContactFromHashToken(lastViewed.id, contacts);
      if (contact) {
        setActiveConversationState({
          type: 'contact',
          id: contact.public_key,
          name: getContactDisplayName(contact.name, contact.public_key, contact.last_advert),
        });
        hasSetDefaultConversation.current = true;
        return;
      }

      const publicConversation = getPublicChannelConversation();
      if (publicConversation) {
        setActiveConversationState(publicConversation);
        hasSetDefaultConversation.current = true;
      }
    }
  }, [
    contacts,
    channels,
    activeConversation,
    contactsLoaded,
    getPublicChannelConversation,
    hasSetDefaultConversation,
    routeConversation,
  ]);

  // Keep ref in sync and update URL hash
  useEffect(() => {
    activeConversationRef.current = activeConversation;
    if (isHandlingPopstateRef.current) {
      // URL is already correct from the browser's popstate — no update needed
      isHandlingPopstateRef.current = false;
    } else if (activeConversation) {
      if (!onNavigateConversation && hashSyncEnabledRef.current && !suspendHashSync) {
        if (shouldPushHistoryRef.current) {
          shouldPushHistoryRef.current = false;
          pushUrlHash(activeConversation);
        } else {
          updateUrlHash(activeConversation);
        }
      }
    }
    if (activeConversation && activeConversation.type !== 'search') {
      saveLastViewedConversation(activeConversation);
    }
  }, [activeConversation, onNavigateConversation, suspendHashSync]);

  // Respond to browser back/forward by updating the active conversation
  useEffect(() => {
    const handlePopstate = () => {
      // Resolve the target from the hash. When the hash is empty or doesn't
      // resolve (e.g. back/forward to the bare URL), fall back to the Public
      // channel rather than clearing to null: the initial-load phases are gated
      // by hasSetDefaultConversation and won't re-resolve, so a null here would
      // strand the app on an empty view with no recovery.
      const conv =
        resolveConversationFromHash(channelsRef.current, contactsRef.current) ??
        resolvePublicFromChannels(channelsRef.current);
      if (!conv) return;
      hashSyncEnabledRef.current = true;
      isHandlingPopstateRef.current = true;
      setActiveConversationState(conv);
    };

    window.addEventListener('popstate', handlePopstate);
    return () => window.removeEventListener('popstate', handlePopstate);
  }, []);

  // If a delete action left us without an active conversation, recover to Public
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
    setActiveConversationState({
      type: 'channel',
      id: publicChannel.key,
      name: publicChannel.name,
    });
  }, [activeConversation, channels, hasSetDefaultConversation, pendingDeleteFallbackRef]);

  // Handle conversation selection (closes sidebar on mobile)
  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      setActiveConversation(conv);
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
