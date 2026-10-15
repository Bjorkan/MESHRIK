import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api';
import { SettingsStatisticsSection } from '../components/settings/SettingsStatisticsSection';
import type { StatisticsResponse } from '../types';

const emptyStats: StatisticsResponse = {
  busiest_channels_24h: [],
  contact_count: 0,
  repeater_count: 0,
  channel_count: 0,
  total_packets: 0,
  decrypted_packets: 0,
  undecrypted_packets: 0,
  total_dms: 0,
  total_channel_messages: 0,
  total_outgoing: 0,
  contacts_heard: { last_hour: 0, last_24_hours: 0, last_week: 0 },
  repeaters_heard: { last_hour: 0, last_24_hours: 0, last_week: 0 },
  known_channels_active: { last_hour: 0, last_24_hours: 0, last_week: 0 },
  path_hash_width_24h: {
    total_packets: 0,
    single_byte: 0,
    double_byte: 0,
    triple_byte: 0,
    single_byte_pct: 0,
    double_byte_pct: 0,
    triple_byte_pct: 0,
  },
  region_scope_24h: {
    total_messages: 0,
    scoped_messages: 0,
    scoped_pct: 0,
    false_positive_floor: 0,
    total_senders: 0,
    scoped_senders: 0,
    scoped_senders_pct: 0,
  },
  packets_per_hour_72h: [],
  noise_floor_24h: {
    sample_interval_seconds: 60,
    coverage_seconds: 0,
    latest_noise_floor_dbm: null,
    latest_timestamp: null,
    samples: [],
  },
};

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsStatisticsSection />
    </QueryClientProvider>
  );
}

describe('SettingsStatisticsSection request states', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('distinguishes a successful empty response from failure', async () => {
    vi.spyOn(api, 'getStatistics').mockResolvedValue(emptyStats);
    renderSection();

    expect(await screen.findByText(/No stored mesh activity yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load statistics/)).not.toBeInTheDocument();
    expect(screen.getByText(/Last updated/)).toBeInTheDocument();
  });

  it('retries an initial failure without remounting', async () => {
    vi.spyOn(api, 'getStatistics')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...emptyStats, contact_count: 1 });
    renderSection();

    expect(await screen.findByText(/Failed to load statistics: offline/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Network')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('keeps previous data visible and labels it stale after refresh failure', async () => {
    const request = vi
      .spyOn(api, 'getStatistics')
      .mockResolvedValueOnce({ ...emptyStats, contact_count: 2 })
      .mockRejectedValueOnce(new Error('timeout'));
    renderSection();

    expect(await screen.findByText('Network')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(
      await screen.findByText(/Showing statistics from the last successful update/)
    ).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('disables refresh while one request is pending', async () => {
    let resolveRefresh!: (value: StatisticsResponse) => void;
    vi.spyOn(api, 'getStatistics')
      .mockResolvedValueOnce({ ...emptyStats, contact_count: 3 })
      .mockImplementationOnce(
        () =>
          new Promise<StatisticsResponse>((resolve) => {
            resolveRefresh = resolve;
          })
      );
    renderSection();

    expect(await screen.findByText('Network')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const pending = await screen.findByRole('button', { name: 'Refreshing…' });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(api.getStatistics).toHaveBeenCalledTimes(2);

    resolveRefresh({ ...emptyStats, contact_count: 4 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });
});
