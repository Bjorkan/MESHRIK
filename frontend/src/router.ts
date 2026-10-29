import { createBrowserHistory, createRouter, type RouterHistory } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

import { routeTree } from './routeTree.gen';
import { createAppQueryClient } from './queryClient';
import { appBasePath } from './basePath';

export interface AppRouterContext {
  queryClient: QueryClient;
}

export function createAppRouter(
  history: RouterHistory = createBrowserHistory(),
  queryClient: QueryClient = createAppQueryClient()
) {
  return createRouter({
    routeTree,
    basepath: appBasePath(),
    history,
    context: { queryClient },
    defaultPreload: 'intent',
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
