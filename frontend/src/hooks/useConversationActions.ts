import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useCallback, type RefObject } from 'react';
import { api } from '../api';
import { toast } from '../components/ui/sonner';
import type { MessageInputHandle } from '../components/MessageInput';
import type { Channel, Contact, Conversation, Message, PathDiscoveryResponse } from '../types';
import { mergeContactIntoList } from '../utils/contactMerge';

interface UseConversationActionsArgs {
  activeConversation: Conversation | null;
  setContacts: React.Dispatch<React.SetStateAction<Contact[]>>;
  setChannels: React.Dispatch<React.SetStateAction<Channel[]>>;
  observeMessage: (msg: Message) => { added: boolean; activeConversation: boolean };
  messageInputRef: RefObject<MessageInputHandle | null>;
}

interface UseConversationActionsResult {
  handleSendMessage: (text: string) => Promise<void>;
  handleResendChannelMessage: (messageId: number, newTimestamp?: boolean) => Promise<void>;
  handleSetChannelFloodScopeOverride: (
    channelKey: string,
    floodScopeOverride: string
  ) => Promise<void>;
  handleSetChannelPathHashModeOverride: (
    channelKey: string,
    pathHashModeOverride: number | null
  ) => Promise<void>;
  handleSenderClick: (sender: string) => void;
  handleTrace: () => Promise<void>;
  handlePathDiscovery: (publicKey: string) => Promise<PathDiscoveryResponse>;
}

export function useConversationActions({
  activeConversation,
  setContacts,
  setChannels,
  observeMessage,
  messageInputRef,
}: UseConversationActionsArgs): UseConversationActionsResult {
  useLingui();

  const mergeChannelIntoList = useCallback(
    (updated: Channel) => {
      setChannels((prev) => {
        const existingIndex = prev.findIndex((channel) => channel.key === updated.key);
        if (existingIndex === -1) {
          return [...prev, updated].sort((a, b) => a.name.localeCompare(b.name));
        }
        const next = [...prev];
        next[existingIndex] = updated;
        return next;
      });
    },
    [setChannels]
  );

  const handleSendMessage = useCallback(
    async (text: string) => {
      if (!activeConversation) return;

      const sent =
        activeConversation.type === 'channel'
          ? await api.sendChannelMessage(activeConversation.id, text)
          : await api.sendDirectMessage(activeConversation.id, text);

      observeMessage(sent);
    },
    [activeConversation, observeMessage]
  );

  const handleResendChannelMessage = useCallback(
    async (messageId: number, newTimestamp?: boolean) => {
      try {
        const resent = await api.resendChannelMessage(messageId, newTimestamp);
        const resentMessage = resent.message;
        if (newTimestamp && resentMessage) {
          observeMessage(resentMessage);
        }
        toast.success(newTimestamp ? t`Message resent with new timestamp` : t`Message resent`);
      } catch (err) {
        toast.error(t`Failed to resend`, {
          description: err instanceof Error ? err.message : t`Unknown error`,
        });
      }
    },
    [observeMessage]
  );

  const handleSetChannelFloodScopeOverride = useCallback(
    async (channelKey: string, floodScopeOverride: string) => {
      const updated = await api.setChannelFloodScopeOverride(channelKey, floodScopeOverride);
      mergeChannelIntoList(updated);
      toast.success(
        updated.flood_scope_override ? t`Regional override saved` : t`Regional override cleared`
      );
    },
    [mergeChannelIntoList]
  );

  const handleSetChannelPathHashModeOverride = useCallback(
    async (channelKey: string, pathHashModeOverride: number | null) => {
      const updated = await api.setChannelPathHashModeOverride(channelKey, pathHashModeOverride);
      mergeChannelIntoList(updated);
      toast.success(
        updated.path_hash_mode_override != null
          ? t`Path hop width override saved`
          : t`Path hop width override cleared`
      );
    },
    [mergeChannelIntoList]
  );

  const handleSenderClick = useCallback(
    (sender: string) => {
      messageInputRef.current?.appendText(`@[${sender}] `);
    },
    [messageInputRef]
  );

  const handleTrace = useCallback(async () => {
    if (!activeConversation || activeConversation.type !== 'contact') return;
    toast(t`Trace started...`);
    try {
      const result = await api.requestTrace(activeConversation.id);
      const parts: string[] = [];
      if (result.remote_snr !== null) parts.push(`Remote SNR: ${result.remote_snr.toFixed(1)} dB`);
      if (result.local_snr !== null) parts.push(`Local SNR: ${result.local_snr.toFixed(1)} dB`);
      const detail = parts.join(', ');
      toast.success(detail ? t`Trace complete! ${detail}` : t`Trace complete!`);
    } catch (err) {
      toast.error(t`Trace failed`, {
        description: err instanceof Error ? err.message : t`Unknown error`,
      });
    }
  }, [activeConversation]);

  const handlePathDiscovery = useCallback(
    async (publicKey: string) => {
      const result = await api.requestPathDiscovery(publicKey);
      setContacts((prev) => mergeContactIntoList(prev, result.contact));
      return result;
    },
    [setContacts]
  );

  return {
    handleSendMessage,
    handleResendChannelMessage,
    handleSetChannelFloodScopeOverride,
    handleSetChannelPathHashModeOverride,
    handleSenderClick,
    handleTrace,
    handlePathDiscovery,
  };
}
