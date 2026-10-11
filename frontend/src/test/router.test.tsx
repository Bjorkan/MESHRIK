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
    expect(router.state.matches[router.state.matches.length - 1]?.routeId).toBe('/');
  });

  it('renders the application not-found UI for an unknown pathname', async () => {
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ['/does-not-exist'] })
    );

    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>
    );

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to MESHRIK' })).toHaveAttribute('href', '/');
  });
});
