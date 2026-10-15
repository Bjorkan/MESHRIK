import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusBar } from '../components/StatusBar';
import { ThemeSelector } from '../components/settings/ThemeSelector';
import type { HealthStatus } from '../types';
import { FOLLOW_OS_THEME_ID, applyTheme } from '../utils/theme';

const health: HealthStatus = {
  status: 'degraded',
  radio_connected: false,
  radio_initializing: false,
  connection_info: null,
  database_size_mb: 1,
  oldest_undecrypted_timestamp: null,
  fanout_statuses: {},
  bots_disabled: false,
};

const originalMatchMedia = globalThis.matchMedia;

function selectedTheme(): HTMLInputElement {
  return screen.getByRole('radio', { checked: true });
}

describe('ThemeSelector synchronization', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
  });

  it('follows StatusBar changes without remounting', () => {
    render(
      <>
        <StatusBar health={health} config={null} onSettingsClick={() => {}} />
        <ThemeSelector />
      </>
    );

    expect(selectedTheme().value).toBe('original');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(selectedTheme().value).toBe('light');
  });

  it('updates StatusBar when the selector changes the preference', () => {
    render(
      <>
        <StatusBar health={health} config={null} onSettingsClick={() => {}} />
        <ThemeSelector />
      </>
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Cyberpunk' }));

    expect(localStorage.getItem('meshrik-theme')).toBe('cyberpunk');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('keeps Follow OS selected when the effective appearance changes', () => {
    let prefersLight = false;
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({
        get matches() {
          return prefersLight;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    applyTheme(FOLLOW_OS_THEME_ID);
    render(<ThemeSelector />);

    act(() => {
      prefersLight = true;
      applyTheme(FOLLOW_OS_THEME_ID);
    });

    expect(selectedTheme().value).toBe(FOLLOW_OS_THEME_ID);
    expect(localStorage.getItem('meshrik-theme')).toBe(FOLLOW_OS_THEME_ID);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies external storage updates and cleans up across StrictMode remounts', () => {
    const { unmount } = render(
      <StrictMode>
        <ThemeSelector />
      </StrictMode>
    );

    act(() => {
      localStorage.setItem('meshrik-theme', 'light');
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'meshrik-theme',
          newValue: 'light',
        })
      );
    });
    expect(selectedTheme().value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    unmount();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'meshrik-theme',
        newValue: 'cyberpunk',
      })
    );
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
