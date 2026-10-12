import { useCallback, useMemo } from 'react';
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';

import { App } from './App';
import type { Conversation } from './types';
import { getToolConversation } from './routing/toolRoutes';
import { getSettingsSection } from './routing/settingsRoutes';
import { getEntityRoute } from './routing/entityRoutes';
import type { SettingsSection } from './components/settings/settingsConstants';

export interface SettingsReturnRoute {
  conversation: Conversation | null;
  entity: ReturnType<typeof getEntityRoute>;
}

declare module '@tanstack/history' {
  interface HistoryState {
    settingsReturnRoute?: SettingsReturnRoute;
  }
}

export function RoutedApp() {
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  const navigate = useNavigate();
  const routeConversation = useMemo(
    () => getToolConversation(location.pathname, location.search as Record<string, unknown>),
    [location.pathname, location.search]
  );
  const routeSettingsSection = getSettingsSection(location.pathname);
  const routeEntity = getEntityRoute(location.pathname);

  const handleNavigateConversation = useCallback(
    (conversation: Conversation, options?: { replace?: boolean }) => {
      switch (conversation.type) {
        case 'raw':
          void navigate({ to: '/raw', replace: options?.replace });
          return;
        case 'map':
          void navigate({
            to: '/map',
            search: conversation.mapFocusKey ? { focus: conversation.mapFocusKey } : {},
            replace: options?.replace,
          });
          return;
        case 'visualizer':
          void navigate({ to: '/visualizer', replace: options?.replace });
          return;
        case 'search':
          void navigate({ to: '/search', replace: options?.replace });
          return;
        case 'trace':
          void navigate({ to: '/trace', replace: options?.replace });
          return;
        case 'radio-activity':
          void navigate({ to: '/radio-activity', replace: options?.replace });
          return;
        case 'channel':
          void navigate({
            to: '/channel/$channelId',
            params: { channelId: conversation.id },
            replace: options?.replace,
          });
          return;
        case 'contact':
          void navigate({
            to: '/contact/$publicKey',
            params: { publicKey: conversation.id },
            replace: options?.replace,
          });
      }
    },
    [navigate]
  );

  const handleNavigateSettings = useCallback(
    (section: SettingsSection) => {
      const settingsReturnRoute =
        routeSettingsSection === null
          ? { conversation: routeConversation, entity: routeEntity }
          : location.state.settingsReturnRoute;
      const options = {
        state: (previous: typeof location.state) => ({
          ...previous,
          ...(settingsReturnRoute ? { settingsReturnRoute } : {}),
        }),
      };
      switch (section) {
        case 'radio':
          void navigate({ to: '/settings/radio', ...options });
          return;
        case 'local':
          void navigate({ to: '/settings/local', ...options });
          return;
        case 'radio-app':
          void navigate({ to: '/settings/radio-app', ...options });
          return;
        case 'fanout':
          void navigate({ to: '/settings/fanout', ...options });
          return;
        case 'database':
          void navigate({ to: '/settings/database', ...options });
          return;
        case 'statistics':
          void navigate({ to: '/settings/statistics', ...options });
          return;
        case 'about':
          void navigate({ to: '/settings/about', ...options });
      }
    },
    [location, navigate, routeConversation, routeEntity, routeSettingsSection]
  );

  const handleCloseSettingsRoute = useCallback(() => {
    const { conversation, entity } = location.state.settingsReturnRoute ?? {
      conversation: null,
      entity: null,
    };
    if (conversation) {
      handleNavigateConversation(conversation);
      return;
    }
    if (entity?.type === 'channel') {
      void navigate({ to: '/channel/$channelId', params: { channelId: entity.id } });
      return;
    }
    if (entity?.type === 'contact') {
      void navigate({ to: '/contact/$publicKey', params: { publicKey: entity.id } });
      return;
    }
    void navigate({ to: '/' });
  }, [handleNavigateConversation, location.state.settingsReturnRoute, navigate]);

  return (
    <App
      queryClient={router.options.context.queryClient}
      routeConversation={routeConversation}
      routeEntity={routeEntity}
      routeIsRoot={location.pathname === '/'}
      onNavigateConversation={handleNavigateConversation}
      routeSettingsSection={routeSettingsSection}
      onNavigateSettings={handleNavigateSettings}
      onCloseSettingsRoute={handleCloseSettingsRoute}
    />
  );
}
