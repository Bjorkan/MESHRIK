import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RadioActivityPage } from './RadioActivityPage';
import { useRadioJobFeed } from '../hooks/useRadioJobFeed';
import { reconcileRadioJobs, partitionRadioJobs } from '../hooks/useRadioActivity';
import type { components } from '../generated/api-schema';

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
  return (
    <>
      <RadioActivityPage feed={feed} connection={socket} health={null} />
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
    expect(screen.getByText('Unavailable (TX / listening not measured)')).toBeInTheDocument();
    expect(screen.getByText('Packet received')).toBeInTheDocument();
    expect(screen.getByText('Outcome unknown')).toBeInTheDocument();
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
    expect(screen.getByText('No completed or stopped jobs found.')).toBeInTheDocument();
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
