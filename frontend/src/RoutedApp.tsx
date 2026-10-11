import { useCallback, useMemo, useRef } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';

import { App } from './App';
import type { Conversation } from './types';
import { getConversationHash } from './utils/urlHash';
import { getToolConversation } from './routing/toolRoutes';
import { getSettingsSection } from './routing/settingsRoutes';
import type { SettingsSection } from './components/settings/settingsConstants';

export function RoutedApp() {
  const location = useRouterState({ select: (state) => state.location });
  const navigate = useNavigate();
  const routeConversation = useMemo(
    () => getToolConversation(location.pathname, location.search as Record<string, unknown>),
    [location.pathname, location.search]
  );
  const routeSettingsSection = getSettingsSection(location.pathname);
  const previousNonSettingsHrefRef = useRef('/');
  if (routeSettingsSection === null) {
    previousNonSettingsHrefRef.current = location.href;
  }

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

  const handleNavigateSettings = useCallback(
    (section: SettingsSection) => {
      switch (section) {
        case 'radio':
          void navigate({ to: '/settings/radio' });
          return;
        case 'local':
          void navigate({ to: '/settings/local' });
          return;
        case 'radio-app':
          void navigate({ to: '/settings/radio-app' });
          return;
        case 'fanout':
          void navigate({ to: '/settings/fanout' });
          return;
        case 'database':
          void navigate({ to: '/settings/database' });
          return;
        case 'statistics':
          void navigate({ to: '/settings/statistics' });
          return;
        case 'about':
          void navigate({ to: '/settings/about' });
      }
    },
    [navigate]
  );

  const handleCloseSettingsRoute = useCallback(() => {
    void navigate({ href: previousNonSettingsHrefRef.current });
  }, [navigate]);

  return (
    <App
      routeConversation={routeConversation}
      onNavigateConversation={handleNavigateConversation}
      routeSettingsSection={routeSettingsSection}
      onNavigateSettings={handleNavigateSettings}
      onCloseSettingsRoute={handleCloseSettingsRoute}
    />
  );
}
