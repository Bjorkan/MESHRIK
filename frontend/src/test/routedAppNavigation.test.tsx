import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '../router';
import type { Conversation } from '../types';
import type { SettingsSection } from '../components/settings/settingsConstants';

interface RoutedAppTestProps {
  onNavigateConversation?: (conversation: Conversation) => void;
  onNavigateSettings?: (section: SettingsSection) => void;
  onCloseSettingsRoute?: () => void;
}

vi.mock('../App', () => ({
  App: ({
    onNavigateConversation,
    onNavigateSettings,
    onCloseSettingsRoute,
  }: RoutedAppTestProps) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onNavigateConversation?.({ type: 'channel', id: 'channel-key', name: 'Ops' })
        }
      >
        Open channel
      </button>
      <button
        type="button"
        onClick={() =>
          onNavigateConversation?.({
            type: 'map',
            id: 'map',
            name: 'Node Map',
            mapFocusKey: 'contact-key',
          })
        }
      >
        Open focused map
      </button>
      <button type="button" onClick={() => onNavigateSettings?.('radio-app')}>
        Open settings
      </button>
      <button type="button" onClick={onCloseSettingsRoute}>
        Close settings
      </button>
    </div>
  ),
}));

describe('RoutedApp navigation actions', () => {
  it('routes conversation selections and focused map actions canonically', async () => {
    const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));
    await router.load();
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open channel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/channel/channel-key'));

    fireEvent.click(screen.getByRole('button', { name: 'Open focused map' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/map');
      expect(router.state.location.search).toEqual({ focus: 'contact-key' });
    });
  });

  it('returns from settings through the saved typed entity route', async () => {
    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ['/contact/contact-key'] })
    );
    await router.load();
    render(<RouterProvider router={router} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/radio-app'));

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/contact/contact-key'));
  });
});
