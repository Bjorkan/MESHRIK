import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RadioActivityPage } from './RadioActivityPage';
import { useRadioJobFeed } from '../hooks/useRadioJobFeed';
import { reconcileRadioJobs, partitionRadioJobs } from '../hooks/useRadioActivity';
import type { components } from '../generated/api-schema';
import type { HealthStatus } from '../types';

const mocks = vi.hoisted(() => ({
  getRadioJobs: vi.fn(),
  getRadioActivity: vi.fn(),
  cancelRadioJob: vi.fn(),
}));
vi.mock('../api', () => ({ api: mocks }));

type Job = components['schemas']['RadioJobSnapshot'];
type Radio = components['schemas']['RadioStatusSnapshot'];
type Activity = components['schemas']['RadioActivityRecord'];
const radio: Radio = {
  radio_status: 'connected',
  startup_policy: 'full',
  command_status: 'executing',
  radio_generation: 3,
  sequence: 12,
  physical_rf_state: 'unavailable',
};
const statuses = {
  executing: { stage: 'transport_command', kind: 'channel_message' },
  awaiting_ack: { stage: 'waiting_for_ack', kind: 'direct_message' },
  awaiting_response: { stage: 'waiting_for_response', kind: 'repeater_login' },
  queued: { stage: 'waiting_turn', kind: 'radio_settings' },
  unknown: { stage: 'uncertain', kind: 'direct_message' },
  completed: { stage: 'finished', kind: 'advertisement' },
} as const;

function job(state: keyof typeof statuses, i: number, overrides: Partial<Job> = {}): Job {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    kind: statuses[state].kind,
    state,
    stage: statuses[state].stage,
    priority: state === 'queued' ? 10 : 0,
    version: 1,
    sequence: 20 - i,
    radio_generation: 3,
    attempt: 1,
    cancellation_requested: false,
    created_at: '2026-10-10T20:00:00Z',
    updated_at: '2026-10-10T20:00:00Z',
    queue_entered_at: '2026-10-10T20:00:00Z',
    correlation_scope: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}
const jobs = [
  job('executing', 1),
  job('awaiting_ack', 2),
  job('awaiting_response', 3),
  job('queued', 4),
  job('unknown', 5),
  job('completed', 6),
];
const activity: Activity = {
  sequence: 10,
  kind: 'packet_received',
  source: 'raw_rf_log',
  radio_generation: 3,
  at: '2026-10-10T20:00:00Z',
};
function Harness({ socket = 'live' }: { socket?: 'live' | 'offline' | 'connecting' }) {
  const feed = useRadioJobFeed();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  return (
    <>
      <RadioActivityPage feed={feed} connection={socket} health={health} />
      <button
        onClick={() =>
          setHealth({
            radio_connected: true,
            radio_state: 'ready',
          } as HealthStatus)
        }
      >
        Simulate unchanged health
      </button>
      <button
        onClick={() =>
          setHealth({
            radio_connected: false,
            radio_state: 'disconnected',
          } as HealthStatus)
        }
      >
        Simulate disconnected health
      </button>
      <button
        onClick={() =>
          feed.onRadioActivity({
            sequence: 200,
            kind: 'connection_changed',
            source: 'radio_lifecycle',
            at: '2026-10-16T12:00:00Z',
            radio_generation: 4,
            previous_connected: true,
            connected: false,
            previous_readiness: 'ready',
            readiness: 'disconnected',
          })
        }
      >
        Simulate transition event
      </button>
      <button onClick={() => feed.onRadioActivity({ ...activity, sequence: 11 })}>
        Simulate inbound
      </button>
      <button onClick={feed.onReconnect}>Simulate reconnect</button>
    </>
  );
}
function createView(socket: 'live' | 'offline' | 'connecting' = 'live') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <Harness socket={socket} />
      </QueryClientProvider>
    ),
  };
}

describe('Radio Activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRadioJobs.mockImplementation(
      async (params: { status?: Job['state']; cursor?: number }) => ({
        items: jobs.filter(
          (item) =>
            (!params.status || item.state === params.status) &&
            (params.cursor === undefined || item.sequence < params.cursor)
        ),
        radio,
        snapshot_sequence: 20,
        next_cursor: null,
        has_more: false,
      })
    );
    mocks.getRadioActivity.mockResolvedValue({
      items: [activity],
      gap: false,
      has_more: false,
      snapshot_sequence: 20,
      next_cursor: 10,
      radio,
    });
    mocks.cancelRadioJob.mockImplementation(async (id: string) => ({
      action: 'cancelled_before_dispatch',
      job: {
        ...jobs.find((j) => j.id === id)!,
        state: 'cancelled',
        stage: 'cancelled',
        version: 2,
        sequence: 21,
      },
    }));
  });

  it('renders an executing command alongside two independent RF waits and a queued operation', async () => {
    createView();
    const ongoing = await screen.findByRole('region', { name: 'Ongoing operations' });
    const queued = screen.getByRole('region', { name: 'Queued' });
    await waitFor(() => expect(within(ongoing).getByText('Executing command')).toBeInTheDocument());
    expect(within(ongoing).getByText('Executing command')).toBeInTheDocument();
    expect(within(ongoing).getByText('Waiting for ACK')).toBeInTheDocument();
    expect(within(ongoing).getByText('Waiting for response')).toBeInTheDocument();
    expect(
      within(queued).getByRole('button', { name: 'Cancel Radio settings' })
    ).toBeInTheDocument();
    expect(screen.getByText('Executing Channel message command')).toBeInTheDocument();
    expect(screen.getByText(/RF TX\/RX unmeasured/)).toBeInTheDocument();
    expect(screen.getByText('Packet received')).toBeInTheDocument();
    expect(screen.getByText('Outcome unknown')).toBeInTheDocument();
  });

  it('renders sanitized connection transition metadata', async () => {
    mocks.getRadioActivity.mockResolvedValue({
      items: [
        {
          sequence: 21,
          kind: 'connection_changed',
          source: 'radio_lifecycle',
          radio_generation: 4,
          at: '2026-10-10T20:01:00Z',
          previous_connected: false,
          connected: true,
          previous_readiness: 'disconnected',
          readiness: 'initializing',
        },
      ],
      gap: false,
      has_more: false,
      snapshot_sequence: 21,
      next_cursor: 21,
      radio,
    });

    createView();

    expect(await screen.findByText('Radio connection changed')).toBeInTheDocument();
    expect(screen.getByText('disconnected → initializing · generation 4')).toBeInTheDocument();
  });

  it('keeps the bounded activity buffer stable across repeated health UI updates', async () => {
    const recent = Array.from({ length: 100 }, (_, index): Activity => ({
      ...activity,
      sequence: index + 1,
    }));
    mocks.getRadioActivity.mockResolvedValue({
      items: recent,
      gap: false,
      has_more: false,
      snapshot_sequence: 100,
      next_cursor: 100,
      radio,
    });
    createView();
    const events = await screen.findByRole('region', {
      name: 'Received events',
    });
    await waitFor(() => expect(within(events).getByText('100')).toBeInTheDocument());

    for (let index = 0; index < 120; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Simulate unchanged health' }));
    }
    expect(within(events).getByText('100')).toBeInTheDocument();
    expect(within(events).queryByText('Radio connection changed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Simulate disconnected health' }));
    expect(within(events).getByText('100')).toBeInTheDocument();
    // Health status is not itself a received activity event; only the
    // authoritative radio_activity frame should add a transition.
    fireEvent.click(screen.getByRole('button', { name: 'Simulate transition event' }));
    await waitFor(() =>
      expect(within(events).getByText('Radio connection changed')).toBeInTheDocument()
    );
    expect(within(events).getByText('100')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Simulate transition event' }));
    expect(within(events).getAllByText('Radio connection changed')).toHaveLength(1);
  });

  it('guarantees queued cancellation is distinct from stopping an RF wait', async () => {
    createView();
    const queued = await screen.findByRole('region', { name: 'Queued' });
    await waitFor(() =>
      expect(
        within(queued).getByRole('button', { name: 'Cancel Radio settings' })
      ).toBeInTheDocument()
    );
    fireEvent.click(within(queued).getByRole('button', { name: 'Cancel Radio settings' }));
    await waitFor(() => expect(mocks.cancelRadioJob).toHaveBeenCalledWith(jobs[3].id));
    await waitFor(() =>
      expect(
        within(queued).queryByRole('button', { name: 'Cancel Radio settings' })
      ).not.toBeInTheDocument()
    );
    const ongoing = screen.getByRole('region', { name: 'Ongoing operations' });
    fireEvent.click(
      within(ongoing).getByRole('button', { name: 'Stop waiting for Direct message' })
    );
    expect(
      screen.getByText(/cannot retract a command already sent over radio/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(mocks.cancelRadioJob).toHaveBeenCalledTimes(1);
    fireEvent.click(
      within(ongoing).getByRole('button', { name: 'Stop waiting for Direct message' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting', hidden: false }));
    await waitFor(() => expect(mocks.cancelRadioJob).toHaveBeenCalledWith(jobs[1].id));
  });

  it('shows stale state when socket is offline, and filters history with server-side status', async () => {
    createView('offline');
    expect(screen.getByText(/Offline — snapshots may be stale/)).toBeInTheDocument();
    await screen.findByText('Outcome unknown');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter job history' }), {
      target: { value: 'failed' },
    });
    await waitFor(() =>
      expect(mocks.getRadioJobs).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    );
    expect(screen.getByText(/No matching history/)).toBeInTheDocument();
  });

  it('merges inbound events without consuming the command queue and resyncs missed events on reconnect', async () => {
    createView();
    const queue = await screen.findByRole('region', { name: 'Queued' });
    await waitFor(() => expect(within(queue).getByText('Radio settings')).toBeInTheDocument());
    const events = screen.getByRole('region', { name: 'Received events' });
    expect(within(events).getAllByText('Packet received')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Simulate inbound' }));
    await waitFor(() => expect(within(events).getAllByText('Packet received')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Simulate inbound' }));
    expect(within(events).getAllByText('Packet received')).toHaveLength(2);
    expect(within(queue).getByText('Radio settings')).toBeInTheDocument();
    mocks.getRadioActivity.mockResolvedValue({
      items: [activity, { ...activity, sequence: 11 }, { ...activity, sequence: 12 }],
      gap: false,
      has_more: false,
      snapshot_sequence: 21,
      next_cursor: 12,
      radio,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate reconnect' }));
    await waitFor(() => expect(within(events).getAllByText('Packet received')).toHaveLength(3));
    expect(within(queue).getByText('Radio settings')).toBeInTheDocument();
  });

  it('uses scheduler aging to order queued work without starving older low-priority jobs', () => {
    const now = Date.parse('2026-10-10T20:02:00Z');
    const high = job('queued', 10, { priority: 0, queue_entered_at: '2026-10-10T20:01:40Z' });
    const low = job('queued', 11, { priority: 20, queue_entered_at: '2026-10-10T20:00:00Z' });
    expect(partitionRadioJobs([high, low], now).queued).toEqual([low, high]);
  });

  it('merges out-of-order job versions and partitions active, queued and terminal state', () => {
    const newer = { ...jobs[1], version: 4, sequence: 30 };
    const merged = reconcileRadioJobs([jobs[1], jobs[0]], [newer, jobs[3], jobs[5]]);
    expect(merged.filter((j) => j.id === newer.id)).toEqual([newer]);
    const { active, queued, history } = partitionRadioJobs(merged);
    expect(active).toHaveLength(2);
    expect(queued).toHaveLength(1);
    expect(history).toHaveLength(1);
  });
});

describe('Radio stats job classification', () => {
  it('shows passive read-only radio stats under their own name', async () => {
    mocks.getRadioJobs.mockResolvedValue({
      items: [job('completed', 42, { kind: 'radio_stats_sample' })],
      radio,
      snapshot_sequence: 20,
      next_cursor: null,
      has_more: false,
    });
    createView();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include routine background jobs' }));
    expect(await screen.findByText('Radio stats sample')).toBeTruthy();
    expect(screen.queryByText('Periodic sync')).toBeNull();
  });
});

describe('Radio Activity presentation regressions', () => {
  it('freezes terminal duration at completed_at and reports queue wait for unstarted cancellations', async () => {
    const { jobDuration } = await import('./RadioActivityPage');
    const finished = job('completed', 39, {
      started_at: '2026-10-10T20:00:00Z',
      completed_at: '2026-10-10T20:00:09Z',
    });
    const cancelled = job('completed', 40, {
      state: 'cancelled',
      started_at: null,
      completed_at: '2026-10-10T20:00:03Z',
    });
    expect(jobDuration(finished, Date.parse('2027-01-01T00:00:00Z'))).toBe('9s');
    expect(jobDuration(finished, Date.parse('2028-01-01T00:00:00Z'))).toBe('9s');
    expect(jobDuration(cancelled, Date.parse('2028-01-01T00:00:00Z'))).toBe('3s');
  });
  it('renders a bounded history and opt-in background records', async () => {
    createView();
    const history = await screen.findByRole('region', { name: 'History' });
    expect(within(history).getByRole('group', { name: 'Job history list' })).toHaveClass(
      'max-h-[26rem]'
    );
    expect(
      within(history).getByRole('checkbox', { name: 'Include routine background jobs' })
    ).not.toBeChecked();
  });
});
