import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useConversationNavigation } from '../hooks/useConversationNavigation';
import type { Channel } from '../types';

const publicChannel: Channel = {
  key: '8B3387E9C5CDEA6AC9E5EDBAA115CD72',
  name: 'Public',
  is_hashtag: false,
  on_radio: false,
  last_read_at: null,
  favorite: false,
  muted: false,
};

function createArgs(overrides: Partial<Parameters<typeof useConversationNavigation>[0]> = {}) {
  return {
    channels: [publicChannel],
    handleSelectConversation: vi.fn(),
    ...overrides,
  };
}

describe('useConversationNavigation', () => {
  it('resets the jump target when switching to a non-search conversation', () => {
    const args = createArgs();
    const { result } = renderHook(() => useConversationNavigation(args));

    act(() => {
      result.current.setTargetMessageId(10);
      result.current.handleSelectConversationWithTargetReset({
        type: 'contact',
        id: 'aa'.repeat(32),
        name: 'Alice',
      });
    });

    expect(result.current.targetMessageId).toBeNull();
    expect(args.handleSelectConversation).toHaveBeenCalledWith({
      type: 'contact',
      id: 'aa'.repeat(32),
      name: 'Alice',
    });
  });

  it('preserves the jump target when navigating from search results', () => {
    const args = createArgs();
    const { result } = renderHook(() => useConversationNavigation(args));

    act(() => {
      result.current.handleNavigateToMessage({
        id: 321,
        type: 'CHAN',
        conversation_key: publicChannel.key,
        conversation_name: publicChannel.name,
      });
    });

    expect(result.current.targetMessageId).toBe(321);
    expect(args.handleSelectConversation).toHaveBeenCalledWith(
      {
        type: 'channel',
        id: publicChannel.key,
        name: publicChannel.name,
      },
      { targetMessageId: 321 }
    );
  });

  it('delegates message anchors and search queries to the route owner', () => {
    const onSetRouteTargetMessageId = vi.fn();
    const onNavigateSearchQuery = vi.fn();
    const args = createArgs({
      routeTargetMessageId: null,
      onSetRouteTargetMessageId,
      onNavigateSearchQuery,
    });
    const { result } = renderHook(() => useConversationNavigation(args));

    act(() => {
      result.current.setTargetMessageId(42);
      result.current.handleOpenSearchWithQuery('user:Alice');
    });

    expect(onSetRouteTargetMessageId).toHaveBeenNthCalledWith(1, 42);
    expect(onSetRouteTargetMessageId).toHaveBeenCalledTimes(1);
    expect(onNavigateSearchQuery).toHaveBeenCalledWith('user:Alice');
    expect(args.handleSelectConversation).not.toHaveBeenCalled();
  });

  it('closes the contact info pane when navigating to a channel', () => {
    const args = createArgs();
    const { result } = renderHook(() => useConversationNavigation(args));

    act(() => {
      result.current.handleOpenContactInfo('bb'.repeat(32), true);
      result.current.handleNavigateToChannel(publicChannel.key);
    });

    expect(result.current.infoPaneContactKey).toBeNull();
    expect(args.handleSelectConversation).toHaveBeenCalledWith({
      type: 'channel',
      id: publicChannel.key,
      name: publicChannel.name,
    });
  });
});
