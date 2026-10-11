import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { createAppRouter } from '../router';

describe('application router', () => {
  it('matches the application index at the root pathname', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));

    await router.load();

    expect(router.state.location.pathname).toBe('/');
    expect(router.state.matches[router.state.matches.length - 1]?.routeId).toBe('/_app/');
  });

  it.each([
    ['/raw', '/_app/raw'],
    ['/map', '/_app/map'],
    ['/visualizer', '/_app/visualizer'],
    ['/search', '/_app/search'],
    ['/trace', '/_app/trace'],
    ['/radio-activity', '/_app/radio-activity'],
  ])('matches the %s tool route directly', async (pathname, routeId) => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: [pathname] }));

    await router.load();

    expect(router.state.matches[router.state.matches.length - 1]?.routeId).toBe(routeId);
  });

  it('uses router history for Back and Forward between tool routes', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/raw'] }));
    await router.load();
    await router.navigate({ to: '/map', search: {} });

    router.history.back();
    await router.load();
    expect(router.state.location.pathname).toBe('/raw');

    router.history.forward();
    await router.load();
    expect(router.state.location.pathname).toBe('/map');
  });

  it('renders the application not-found UI for an unknown pathname', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/does-not-exist'] }));

    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    );

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to MESHRIK' })).toHaveAttribute('href', '/');
  });
});
