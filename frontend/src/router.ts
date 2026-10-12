import { createBrowserHistory, createRouter, type RouterHistory } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen';

export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: 'intent',
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
