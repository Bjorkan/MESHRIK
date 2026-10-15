import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { useRadioControl } from '../hooks/useRadioControl';
import type { HealthStatus, RadioConfig } from '../types';

const healthBase: HealthStatus = {
  status: 'degraded',
  radio_connected: true,
  radio_initializing: false,
  connection_info: 'Serial: /dev/ttyUSB0',
  database_size_mb: 1,
  oldest_undecrypted_timestamp: null,
  fanout_statuses: {},
  bots_disabled: false,
};

const config = {
  name: 'Test',
  public_key: 'aa'.repeat(32),
  lat: 0,
  lon: 0,
  tx_power: 17,
  max_tx_power: 22,
  radio: { freq: 910.525, bw: 62.5, sf: 7, cr: 5 },
  path_hash_mode: 0,
  path_hash_mode_supported: false,
  advert_location_source: 'current',
  multi_acks_enabled: false,
  repeat_enabled: null,
  repeat_enabled_supported: false,
} satisfies RadioConfig;

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useRadioControl setup recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects a transport-connected retry until authoritative health is ready', async () => {
    vi.spyOn(api, 'getHealth').mockResolvedValue({
      ...healthBase,
      radio_state: 'failed',
      startup_error_stage: 'device_info',
    });
    vi.spyOn(api, 'getRadioConfig').mockResolvedValue(config);
    vi.spyOn(api, 'reconnectRadio').mockResolvedValue({
      status: 'connected',
      message: 'Transport connected',
      connected: true,
    });
    const { result } = renderHook(() => useRadioControl(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.health?.radio_state).toBe('failed'));
    await expect(result.current.handleReconnect()).rejects.toThrow(
      'Radio setup is still failed at device_info'
    );
    expect(result.current.health?.radio_state).toBe('failed');
  });

  it('accepts retry only after authoritative health reports ready', async () => {
    const getHealth = vi
      .spyOn(api, 'getHealth')
      .mockResolvedValueOnce({ ...healthBase, radio_state: 'failed' })
      .mockResolvedValue({ ...healthBase, status: 'ok', radio_state: 'ready' });
    vi.spyOn(api, 'getRadioConfig').mockResolvedValue(config);
    vi.spyOn(api, 'reconnectRadio').mockResolvedValue({
      status: 'connected',
      message: 'Setup complete',
      connected: true,
    });
    const { result } = renderHook(() => useRadioControl(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.health?.radio_state).toBe('failed'));
    await act(async () => result.current.handleReconnect());

    await waitFor(() => expect(result.current.health?.radio_state).toBe('ready'));
    expect(getHealth).toHaveBeenCalledTimes(2);
  });
});
