import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatusBar } from '../components/StatusBar';
import { api } from '../api';
import { toast } from '../components/ui/sonner';
import type { HealthStatus } from '../types';
import {
  STATUS_DOT_PULSE_DURATION_MS,
  STATUS_DOT_PULSE_PACKET_EVENT,
} from '../utils/statusDotPulse';

vi.mock('../components/ui/sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockedToast = vi.mocked(toast);

const baseHealth: HealthStatus = {
  status: 'degraded',
  radio_connected: false,
  radio_initializing: false,
  connection_info: null,
  database_size_mb: 1.2,
  oldest_undecrypted_timestamp: null,
  fanout_statuses: {},
  bots_disabled: false,
};

describe('StatusBar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('shows Radio Initializing while setup is still running', () => {
    render(
      <StatusBar
        health={{ ...baseHealth, radio_connected: true, radio_initializing: true }}
        config={null}
        onSettingsClick={vi.fn()}
      />
    );

    expect(screen.getByRole('status', { name: 'Radio Initializing' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('shows Radio OK when the radio is connected and ready', () => {
    render(
      <StatusBar
        health={{ ...baseHealth, status: 'ok', radio_connected: true }}
        config={null}
        onSettingsClick={vi.fn()}
      />
    );

    expect(screen.getByRole('status', { name: 'Radio OK' })).toBeInTheDocument();
  });

  it('shows Radio Disconnected when the radio is unavailable', () => {
    render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

    expect(screen.getByRole('status', { name: 'Radio Disconnected' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('shows Radio Paused and a Connect action when reconnect attempts are paused', () => {
    render(
      <StatusBar
        health={{ ...baseHealth, radio_state: 'paused' }}
        config={null}
        onSettingsClick={vi.fn()}
      />
    );

    expect(screen.getByRole('status', { name: 'Radio Paused' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('reports a successful reconnect only when the API confirms connection', async () => {
    vi.spyOn(api, 'reconnectRadio').mockResolvedValue({
      status: 'ok',
      message: 'Connected over serial',
      connected: true,
    });
    render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith('Reconnected', {
        description: 'Connected over serial',
      })
    );
  });

  it('reports HTTP success that still leaves the radio disconnected', async () => {
    vi.spyOn(api, 'reconnectRadio').mockResolvedValue({
      status: 'pending',
      message: 'No radio found yet',
      connected: false,
    });
    render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith('Radio is still disconnected', {
        description: 'No radio found yet',
      })
    );
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it('reports a rejected reconnect request separately', async () => {
    vi.spyOn(api, 'reconnectRadio').mockRejectedValue(new Error('Request timed out'));
    render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith('Reconnection failed', {
        description: 'Request timed out',
      })
    );
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it('blocks duplicate reconnect clicks while the request is pending', async () => {
    let resolveReconnect!: (value: { status: string; message: string; connected: boolean }) => void;
    const reconnect = vi.spyOn(api, 'reconnectRadio').mockReturnValue(
      new Promise((resolve) => {
        resolveReconnect = resolve;
      })
    );
    render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    const pendingButton = screen.getByRole('button', { name: 'Reconnecting...' });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(reconnect).toHaveBeenCalledTimes(1);

    resolveReconnect({ status: 'ok', message: 'Connected', connected: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled());
  });

  it('toggles between classic and light themes from the shortcut button', () => {
    localStorage.setItem('meshrik-theme', 'cyberpunk');

    render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

    const themeToggle = screen.getByRole('button', { name: 'Switch to light theme' });
    fireEvent.click(themeToggle);

    expect(localStorage.getItem('meshrik-theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Switch to classic theme' }));

    expect(localStorage.getItem('meshrik-theme')).toBe('original');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('keeps the latest packet pulse visible for one complete debounced window', async () => {
    localStorage.setItem('meshrik-status-dot-pulse', 'true');
    vi.useFakeTimers();
    try {
      render(
        <StatusBar
          health={{ ...baseHealth, status: 'ok', radio_connected: true }}
          config={null}
          onSettingsClick={vi.fn()}
        />
      );
      const dot = screen
        .getByRole('status', { name: 'Radio OK' })
        .querySelector('div[aria-hidden="true"]') as HTMLElement;

      act(() => {
        window.dispatchEvent(new CustomEvent(STATUS_DOT_PULSE_PACKET_EVENT, { detail: 'channel' }));
      });
      const channelColor = dot.style.backgroundColor;
      expect(channelColor).not.toBe('');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_DOT_PULSE_DURATION_MS - 50);
        window.dispatchEvent(new CustomEvent(STATUS_DOT_PULSE_PACKET_EVENT, { detail: 'dm' }));
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(dot.style.backgroundColor).not.toBe(channelColor);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_DOT_PULSE_DURATION_MS - 60);
      });
      expect(dot.style.backgroundColor).toBe('');
    } finally {
      vi.useRealTimers();
      localStorage.removeItem('meshrik-status-dot-pulse');
    }
  });

  describe('with Follow OS theme saved', () => {
    const originalMatchMedia = globalThis.matchMedia;

    afterEach(() => {
      globalThis.matchMedia = originalMatchMedia;
    });

    // Stub matchMedia so prefers-color-scheme: light returns the desired value.
    const setPrefersLight = (isLight: boolean) => {
      Object.defineProperty(globalThis, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({
          matches: query.includes('light') ? isLight : !isLight,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });
    };

    it('clicking toggle while OS prefers dark overrides follow-os into explicit light', () => {
      setPrefersLight(false);
      localStorage.setItem('meshrik-theme', 'follow-os');

      render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

      // OS is dark → effective is original → toggle offers "Switch to light theme"
      const toggle = screen.getByRole('button', { name: 'Switch to light theme' });
      fireEvent.click(toggle);

      expect(localStorage.getItem('meshrik-theme')).toBe('light');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('clicking toggle while OS prefers light overrides follow-os into explicit dark', () => {
      setPrefersLight(true);
      localStorage.setItem('meshrik-theme', 'follow-os');

      render(<StatusBar health={baseHealth} config={null} onSettingsClick={vi.fn()} />);

      // OS is light → effective is light → toggle offers "Switch to classic theme"
      const toggle = screen.getByRole('button', { name: 'Switch to classic theme' });
      fireEvent.click(toggle);

      expect(localStorage.getItem('meshrik-theme')).toBe('original');
      expect(document.documentElement.dataset.theme).toBeUndefined();
    });
  });
});
