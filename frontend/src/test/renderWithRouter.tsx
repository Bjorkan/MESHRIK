import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';

export async function renderWithRouter(ui: ReactNode, initialEntry = '/') {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => ui,
  });
  const mapRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'map',
  });
  const channelRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'channel/$channelId',
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'settings/radio-app',
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, mapRoute, channelRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  await router.load();
  return { router, ...render(<RouterProvider router={router} />) };
}
