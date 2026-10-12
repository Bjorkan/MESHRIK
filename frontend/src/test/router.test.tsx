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

  it.each([
    ['/settings/radio', '/_app/settings/radio'],
    ['/settings/local', '/_app/settings/local'],
    ['/settings/radio-app', '/_app/settings/radio-app'],
    ['/settings/fanout', '/_app/settings/fanout'],
    ['/settings/database', '/_app/settings/database'],
    ['/settings/statistics', '/_app/settings/statistics'],
    ['/settings/about', '/_app/settings/about'],
  ])('matches the %s settings route directly', async (pathname, routeId) => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: [pathname] }));

    await router.load();

    expect(router.state.matches[router.state.matches.length - 1]?.routeId).toBe(routeId);
  });

  it('redirects /settings to the default radio section', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/settings'] }));

    await router.load();

    expect(router.state.location.pathname).toBe('/settings/radio');
  });

  it('uses native router history across settings and the previous app route', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/raw'] }));
    await router.load();
    await router.navigate({ to: '/settings/radio' });
    await router.navigate({ to: '/settings/database' });

    router.history.back();
    await router.load();
    expect(router.state.location.pathname).toBe('/settings/radio');

    router.history.back();
    await router.load();
    expect(router.state.location.pathname).toBe('/raw');

    router.history.forward();
    await router.load();
    expect(router.state.location.pathname).toBe('/settings/radio');
  });

  it.each([
    ['/channel/ABCDEF0123456789', '/_app/channel/$channelId'],
    ['/contact/' + 'ab'.repeat(32), '/_app/contact/$publicKey'],
  ])('matches the %s entity route directly', async (pathname, routeId) => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: [pathname] }));

    await router.load();

    expect(router.state.matches[router.state.matches.length - 1]?.routeId).toBe(routeId);
  });

  it('uses router history between entity routes', async () => {
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ['/channel/channel-a'] })
    );
    await router.load();
    await router.navigate({ to: '/contact/$publicKey', params: { publicKey: 'contact-b' } });

    router.history.back();
    await router.load();
    expect(router.state.location.pathname).toBe('/channel/channel-a');

    router.history.forward();
    await router.load();
    expect(router.state.location.pathname).toBe('/contact/contact-b');
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

  it('renders not-found for an unknown settings section', async () => {
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ['/settings/not-a-section'] })
    );

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
