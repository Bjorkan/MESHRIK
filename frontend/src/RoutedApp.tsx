import { useCallback, useMemo } from 'react';
import { useMatch, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';

import { App } from './App';
import type { Conversation } from './types';
import type { SettingsSection } from './components/settings/settingsConstants';
import type { EntityRoute } from './routing/entityRoutes';

export interface SettingsReturnRoute {
  conversation: Conversation | null;
  entity: EntityRoute | null;
}

declare module '@tanstack/history' {
  interface HistoryState {
    settingsReturnRoute?: SettingsReturnRoute;
  }
}

export function RoutedApp() {
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  const leafRouteId = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.routeId,
  });
  const navigate = useNavigate();
  const channelMatch = useMatch({ from: '/_app/channel/$channelId', shouldThrow: false });
  const contactMatch = useMatch({ from: '/_app/contact/$publicKey', shouldThrow: false });
  const mapMatch = useMatch({ from: '/_app/map', shouldThrow: false });
  const searchMatch = useMatch({ from: '/_app/search', shouldThrow: false });
  const routeConversation = useMemo((): Conversation | null => {
    switch (leafRouteId) {
      case '/_app/raw':
        return { type: 'raw', id: 'raw', name: 'Raw Packet Feed' };
      case '/_app/map':
        return {
          type: 'map',
          id: 'map',
          name: 'Node Map',
          ...(mapMatch?.search.focus ? { mapFocusKey: mapMatch.search.focus } : {}),
        };
      case '/_app/visualizer':
        return { type: 'visualizer', id: 'visualizer', name: 'Mesh Visualizer' };
      case '/_app/search':
        return { type: 'search', id: 'search', name: 'Message Search' };
      case '/_app/trace':
        return { type: 'trace', id: 'trace', name: 'Trace' };
      case '/_app/radio-activity':
        return { type: 'radio-activity', id: 'radio-activity', name: 'Radio Activity' };
      default:
        return null;
    }
  }, [leafRouteId, mapMatch?.search.focus]);
  const routeSettingsSection = useMemo((): SettingsSection | null => {
    switch (leafRouteId) {
      case '/_app/settings/radio':
        return 'radio';
      case '/_app/settings/local':
        return 'local';
      case '/_app/settings/radio-app':
        return 'radio-app';
      case '/_app/settings/fanout':
        return 'fanout';
      case '/_app/settings/database':
        return 'database';
      case '/_app/settings/statistics':
        return 'statistics';
      case '/_app/settings/about':
        return 'about';
      default:
        return null;
    }
  }, [leafRouteId]);
  const routeEntity = useMemo<EntityRoute | null>(() => {
    if (channelMatch) return { type: 'channel', id: channelMatch.params.channelId };
    if (contactMatch) return { type: 'contact', id: contactMatch.params.publicKey };
    return null;
  }, [channelMatch, contactMatch]);
  const routeTargetMessageId = channelMatch?.search.message ?? contactMatch?.search.message ?? null;
  const routeSearchQuery = searchMatch?.search.q ?? '';

  const handleNavigateConversation = useCallback(
    (
      conversation: Conversation,
      options?: { replace?: boolean; targetMessageId?: number | null }
    ) => {
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
          void navigate({ to: '/search', search: {}, replace: options?.replace });
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
            search: options?.targetMessageId ? { message: options.targetMessageId } : {},
            replace: options?.replace,
          });
          return;
        case 'contact':
          void navigate({
            to: '/contact/$publicKey',
            params: { publicKey: conversation.id },
            search: options?.targetMessageId ? { message: options.targetMessageId } : {},
            replace: options?.replace,
          });
      }
    },
    [navigate]
  );

  const handleNavigateSearchQuery = useCallback(
    (query: string) => {
      const q = query.trim();
      void navigate({
        to: '/search',
        search: q ? { q } : {},
        replace: leafRouteId === '/_app/search',
      });
    },
    [leafRouteId, navigate]
  );

  const handleSetTargetMessageId = useCallback(
    (messageId: number | null) => {
      if (!routeEntity) return;
      const search = messageId ? { message: messageId } : {};
      if (routeEntity.type === 'channel') {
        void navigate({
          to: '/channel/$channelId',
          params: { channelId: routeEntity.id },
          search,
          replace: true,
        });
        return;
      }
      void navigate({
        to: '/contact/$publicKey',
        params: { publicKey: routeEntity.id },
        search,
        replace: true,
      });
    },
    [navigate, routeEntity]
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
      routeTargetMessageId={routeTargetMessageId}
      onSetRouteTargetMessageId={handleSetTargetMessageId}
      routeSearchQuery={routeSearchQuery}
      onNavigateSearchQuery={handleNavigateSearchQuery}
      routeSettingsSection={routeSettingsSection}
      onNavigateSettings={handleNavigateSettings}
      onCloseSettingsRoute={handleCloseSettingsRoute}
    />
  );
}
