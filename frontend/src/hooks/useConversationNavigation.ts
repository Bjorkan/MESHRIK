import { useCallback, useState } from 'react';

import type { SearchNavigateTarget } from '../components/SearchView';
import type { Channel, Conversation } from '../types';

interface UseConversationNavigationArgs {
  channels: Channel[];
  handleSelectConversation: (
    conv: Conversation,
    options?: { targetMessageId?: number | null }
  ) => void;
  routeTargetMessageId?: number | null;
  onSetRouteTargetMessageId?: (messageId: number | null) => void;
  onNavigateSearchQuery?: (query: string) => void;
}

interface UseConversationNavigationResult {
  targetMessageId: number | null;
  setTargetMessageId: (messageId: number | null) => void;
  infoPaneContactKey: string | null;
  infoPaneFromChannel: boolean;
  infoPaneChannelKey: string | null;
  handleOpenContactInfo: (publicKey: string, fromChannel?: boolean) => void;
  handleCloseContactInfo: () => void;
  handleOpenChannelInfo: (channelKey: string) => void;
  handleCloseChannelInfo: () => void;
  handleSelectConversationWithTargetReset: (
    conv: Conversation,
    options?: { preserveTarget?: boolean; targetMessageId?: number | null }
  ) => void;
  handleNavigateToChannel: (channelKey: string) => void;
  handleNavigateToMessage: (target: SearchNavigateTarget) => void;
  handleOpenSearchWithQuery: (query: string) => void;
}

export function useConversationNavigation({
  channels,
  handleSelectConversation,
  routeTargetMessageId,
  onSetRouteTargetMessageId,
  onNavigateSearchQuery,
}: UseConversationNavigationArgs): UseConversationNavigationResult {
  const [localTargetMessageId, setLocalTargetMessageId] = useState<number | null>(null);
  const targetMessageId =
    routeTargetMessageId !== undefined ? routeTargetMessageId : localTargetMessageId;
  const setTargetMessageId = useCallback(
    (messageId: number | null) => {
      if (routeTargetMessageId !== undefined && onSetRouteTargetMessageId) {
        onSetRouteTargetMessageId(messageId);
        return;
      }
      setLocalTargetMessageId(messageId);
    },
    [onSetRouteTargetMessageId, routeTargetMessageId]
  );
  const [infoPaneContactKey, setInfoPaneContactKey] = useState<string | null>(null);
  const [infoPaneFromChannel, setInfoPaneFromChannel] = useState(false);
  const [infoPaneChannelKey, setInfoPaneChannelKey] = useState<string | null>(null);

  const handleOpenContactInfo = useCallback((publicKey: string, fromChannel?: boolean) => {
    setInfoPaneContactKey(publicKey);
    setInfoPaneFromChannel(fromChannel ?? false);
  }, []);

  const handleCloseContactInfo = useCallback(() => {
    setInfoPaneContactKey(null);
  }, []);

  const handleOpenChannelInfo = useCallback((channelKey: string) => {
    setInfoPaneChannelKey(channelKey);
  }, []);

  const handleCloseChannelInfo = useCallback(() => {
    setInfoPaneChannelKey(null);
  }, []);

  const handleSelectConversationWithTargetReset = useCallback(
    (
      conv: Conversation,
      options?: { preserveTarget?: boolean; targetMessageId?: number | null }
    ) => {
      const resetsTarget = conv.type !== 'search' && !options?.preserveTarget;
      if (resetsTarget && routeTargetMessageId === undefined) {
        setLocalTargetMessageId(null);
      }
      const nextTarget =
        options?.targetMessageId !== undefined
          ? options.targetMessageId
          : resetsTarget && routeTargetMessageId !== undefined
            ? null
            : undefined;
      if (nextTarget !== undefined) {
        handleSelectConversation(conv, { targetMessageId: nextTarget });
      } else {
        handleSelectConversation(conv);
      }
    },
    [handleSelectConversation, routeTargetMessageId]
  );

  const handleNavigateToChannel = useCallback(
    (channelKey: string) => {
      const channel = channels.find((item) => item.key === channelKey);
      if (!channel) {
        return;
      }

      handleSelectConversationWithTargetReset({
        type: 'channel',
        id: channel.key,
        name: channel.name,
      });
      setInfoPaneContactKey(null);
    },
    [channels, handleSelectConversationWithTargetReset]
  );

  const handleNavigateToMessage = useCallback(
    (target: SearchNavigateTarget) => {
      const convType = target.type === 'CHAN' ? 'channel' : 'contact';
      if (routeTargetMessageId === undefined) setLocalTargetMessageId(target.id);
      handleSelectConversationWithTargetReset(
        {
          type: convType,
          id: target.conversation_key,
          name: target.conversation_name,
        },
        { preserveTarget: true, targetMessageId: target.id }
      );
    },
    [handleSelectConversationWithTargetReset, routeTargetMessageId]
  );

  const handleOpenSearchWithQuery = useCallback(
    (query: string) => {
      setInfoPaneContactKey(null);
      if (onNavigateSearchQuery) {
        onNavigateSearchQuery(query);
        return;
      }
      setLocalTargetMessageId(null);
      handleSelectConversationWithTargetReset({
        type: 'search',
        id: 'search',
        name: 'Message Search',
      });
    },
    [handleSelectConversationWithTargetReset, onNavigateSearchQuery]
  );

  return {
    targetMessageId,
    setTargetMessageId,
    infoPaneContactKey,
    infoPaneFromChannel,
    infoPaneChannelKey,
    handleOpenContactInfo,
    handleCloseContactInfo,
    handleOpenChannelInfo,
    handleCloseChannelInfo,
    handleSelectConversationWithTargetReset,
    handleNavigateToChannel,
    handleNavigateToMessage,
    handleOpenSearchWithQuery,
  };
}
