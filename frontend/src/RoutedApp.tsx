import { useCallback, useMemo } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';

import { App } from './App';
import type { Conversation } from './types';
import { getConversationHash } from './utils/urlHash';
import { getToolConversation } from './routing/toolRoutes';

export function RoutedApp() {
  const location = useRouterState({ select: (state) => state.location });
  const navigate = useNavigate();
  const routeConversation = useMemo(
    () => getToolConversation(location.pathname, location.search as Record<string, unknown>),
    [location.pathname, location.search]
  );

  const handleNavigateConversation = useCallback(
    (conversation: Conversation) => {
      switch (conversation.type) {
        case 'raw':
          void navigate({ to: '/raw' });
          return;
        case 'map':
          void navigate({
            to: '/map',
            search: conversation.mapFocusKey ? { focus: conversation.mapFocusKey } : {},
          });
          return;
        case 'visualizer':
          void navigate({ to: '/visualizer' });
          return;
        case 'search':
          void navigate({ to: '/search' });
          return;
        case 'trace':
          void navigate({ to: '/trace' });
          return;
        case 'radio-activity':
          void navigate({ to: '/radio-activity' });
          return;
        case 'channel':
        case 'contact':
          // Dynamic routes are introduced in #80. Keep their existing identity
          // during this intermediate migration while moving back to the app root.
          void navigate({ to: '/', hash: getConversationHash(conversation).slice(1) });
      }
    },
    [navigate]
  );

  return (
    <App
      routeConversation={routeConversation}
      onNavigateConversation={handleNavigateConversation}
    />
  );
}
