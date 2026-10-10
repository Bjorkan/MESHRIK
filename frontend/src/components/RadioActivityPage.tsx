/** Radio Activity is an observer of the *one* process-owned radio, not a radio controller. */
import { useEffect, useState } from 'react';
import { Activity, ArrowDown, Clock3, RadioTower, RefreshCw, XCircle } from 'lucide-react';
import type { components } from '../generated/api-schema';
import type { HealthStatus } from '../types';
import { type HistoryFilter, type RadioJobFeed, useRadioActivity } from '../hooks/useRadioActivity';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { cn } from '@/lib/utils';

type Job = components['schemas']['RadioJobSnapshot'];
type ActivityRecord = components['schemas']['RadioActivityRecord'];

type Props = {
  feed: RadioJobFeed;
  connection: 'connecting' | 'live' | 'offline';
  health: HealthStatus | null;
};

const JOB_NAMES: Record<Job['kind'], string> = {
  direct_message: 'Direct message',
  channel_message: 'Channel message',
  repeater_login: 'Repeater login',
  room_login: 'Room login',
  radio_settings: 'Radio settings',
  advertisement: 'Advertisement',
  discovery: 'Discovery',
  radio_query: 'Radio query',
  periodic_sync: 'Periodic sync',
  periodic_advertisement: 'Periodic advertisement',
};
const STATES: Record<Job['state'], string> = {
  queued: 'Queued',
  executing: 'Executing command',
  awaiting_response: 'Waiting for response',
  awaiting_ack: 'Waiting for ACK',
  retrying: 'Retry pending',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Outcome unknown',
};
const STAGES: Record<Job['stage'], string> = {
  waiting_turn: 'Waiting for command turn',
  transport_command: 'Sending command to radio',
  waiting_for_response: 'Waiting for RF reply',
  waiting_for_ack: 'Awaiting RF acknowledgment',
  retry_pending: 'Retry pending',
  finished: 'Command or response confirmed',
  failed: 'Operation failed',
  cancelled: 'Operation cancelled',
  uncertain: 'Transmission outcome uncertain',
};
const ACTIVITY_LABELS: Record<ActivityRecord['kind'], string> = {
  packet_received: 'Packet received',
  ack_observed: 'ACK observed',
  contact_message_observed: 'Contact message observed',
  path_update: 'Path update observed',
  contact_observed: 'Contact observed',
  login_response: 'Login response observed',
  cli_response: 'CLI response observed',
  connection_changed: 'Radio connection changed',
};
const ACTIVITY_SOURCES: Record<ActivityRecord['source'], string> = {
  raw_rf_log: 'Packet log',
  meshcore_event: 'Radio event',
  radio_lifecycle: 'Connection',
};
const FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: 'all', label: 'All outcomes' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'unknown', label: 'Unknown' },
];

function elapsed(start: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(start)) / 1000));
  if (!Number.isFinite(secs)) return '—';
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function clockTime(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.valueOf()) ? '—' : parsed.toLocaleTimeString();
}

function stateClass(state: Job['state']) {
  if (state === 'unknown' || state === 'failed') return 'text-destructive';
  if (state === 'completed') return 'text-success';
  if (state === 'executing') return 'text-primary';
  return 'text-muted-foreground';
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card min-w-0" aria-label={title}>
      <h3 className="text-base font-semibold tracking-tight px-4 py-3 border-b border-border flex gap-2 items-center">
        {title}
        {count !== undefined && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </h3>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

function JobRow({
  job,
  now,
  onCancel,
  pending,
}: {
  job: Job;
  now: number;
  onCancel: (job: Job) => void;
  pending: boolean;
}) {
  const awaiting = job.state === 'awaiting_ack' || job.state === 'awaiting_response';
  const cancellable =
    awaiting || job.state === 'queued' || job.state === 'retrying' || job.state === 'executing';
  const deadline =
    job.state === 'queued'
      ? job.queue_deadline
      : awaiting
        ? job.response_deadline
        : job.command_deadline;
  return (
    <li className="border-b border-border/70 last:border-b-0 py-3 first:pt-0 last:pb-0 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{JOB_NAMES[job.kind]}</p>
          <p className={cn('text-xs mt-0.5', stateClass(job.state))}>{STATES[job.state]}</p>
          <p className="text-xs text-muted-foreground mt-1">{STAGES[job.stage]}</p>
          <p className="text-[0.6875rem] text-muted-foreground mt-1 tabular-nums">
            {job.state === 'queued' ? 'Queue wait' : 'Elapsed'}:{' '}
            {elapsed(job.started_at ?? job.queue_entered_at, now)}
            {' · '}Priority: {job.priority === 0 ? 'High' : job.priority === 10 ? 'Normal' : 'Low'}
            {job.attempt > 1 ? ` · Attempt ${job.attempt}` : ''}
          </p>
          {deadline && (
            <p className="text-[0.6875rem] text-muted-foreground tabular-nums">
              Deadline: {clockTime(deadline)}
            </p>
          )}
          {job.state === 'executing' && (
            <p className="text-[0.6875rem] text-muted-foreground">
              Cancellation is best-effort; an in-flight command may still execute.
            </p>
          )}
          {job.result && (
            <p className="text-[0.6875rem] text-muted-foreground">
              Result: {job.result.replace(/_/g, ' ')}
            </p>
          )}
        </div>
        {cancellable && (
          <Button
            variant="outline"
            size="sm"
            disabled={pending || job.cancellation_requested}
            onClick={() => onCancel(job)}
            aria-label={`${awaiting ? 'Stop waiting for' : job.state === 'executing' ? 'Request cancellation of' : 'Cancel'} ${JOB_NAMES[job.kind]}`}
          >
            {pending
              ? 'Working…'
              : job.cancellation_requested
                ? 'Requested'
                : awaiting
                  ? 'Stop waiting'
                  : job.state === 'executing'
                    ? 'Request cancellation'
                    : 'Cancel job'}
          </Button>
        )}
      </div>
    </li>
  );
}

export function RadioActivityPage({ feed, connection, health }: Props) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  const [stopJob, setStopJob] = useState<Job | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const { active, queued, history, historyQuery, cancel } = useRadioActivity(feed, filter, now);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const radio = feed.jobs.data?.radio ?? feed.activity.data?.radio;
  const executing = active.find((job) => job.state === 'executing');
  const live = connection === 'live';
  // Health messages are sent independently of scheduler deltas. A snapshot's
  // connection status can be stale while the WebSocket is still live.
  const radioConnection =
    health && live
      ? health.radio_initializing
        ? 'connecting'
        : health.radio_connected
          ? 'connected'
          : 'disconnected'
      : radio?.radio_status;
  const disconnected = radioConnection === 'disconnected';
  const commandLabel = disconnected
    ? 'Disconnected'
    : radioConnection === 'connecting'
      ? 'Connecting'
      : !radio
        ? 'Loading status…'
        : executing
          ? `Executing ${JOB_NAMES[executing.kind]} command`
          : radio.command_status === 'legacy_busy'
            ? 'Legacy command in progress'
            : 'Idle';
  const status =
    radioConnection === 'connected'
      ? 'Connected'
      : radioConnection === 'connecting'
        ? 'Connecting'
        : 'Disconnected';

  async function submitCancel(job: Job) {
    setStopJob(null);
    setCancelError(null);
    try {
      await cancel.mutateAsync(job.id);
    } catch {
      setCancelError('Could not update the job. Refresh the snapshot to check its current state.');
    }
  }

  function handleCancel(job: Job) {
    if (job.state === 'awaiting_ack' || job.state === 'awaiting_response') {
      setStopJob(job);
    } else {
      void submitCancel(job);
    }
  }

  const renderJobs = (jobs: Job[], emptyText: string) =>
    jobs.length === 0 ? (
      <p className="text-[0.8125rem] text-muted-foreground">{emptyText}</p>
    ) : (
      <ul className="min-w-0">
        {jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            now={now}
            onCancel={handleCancel}
            pending={cancel.isPending && cancel.variables === job.id}
          />
        ))}
      </ul>
    );

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      aria-label="Radio Activity dashboard"
    >
      <div className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-5 pb-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <RadioTower className="h-5 w-5 text-primary" aria-hidden="true" />
              Radio Activity
            </h2>
            <p className="text-[0.8125rem] text-muted-foreground mt-1">
              One radio, one command at a time; independent RF replies may remain pending.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void feed.jobs.refetch();
              void feed.activity.refetch();
              void historyQuery.refetch();
            }}
            aria-label="Refresh radio activity"
          >
            <RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />
            Refresh
          </Button>
        </div>
        <p aria-live="polite" role="status" className="text-xs text-muted-foreground">
          {connection === 'live'
            ? 'Live WebSocket updates'
            : connection === 'connecting'
              ? 'Connecting to live updates…'
              : 'Offline — snapshots may be stale. Reconnecting…'}
        </p>
        {feed.jobs.isLoading && (
          <p role="status" className="text-sm">
            Loading radio jobs…
          </p>
        )}
        {feed.jobs.isError && (
          <p role="alert" className="text-sm text-destructive">
            Could not load radio jobs. Try Refresh.
          </p>
        )}
        {cancelError && (
          <p role="alert" className="text-sm text-destructive">
            {cancelError}
          </p>
        )}

        <Section title="Radio now">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
                Connection
              </p>
              <p className="font-semibold text-sm mt-1">{radioConnection ? status : 'Checking…'}</p>
            </div>
            <div>
              <p className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
                Command slot
              </p>
              <p className="font-semibold text-sm mt-1" aria-live="polite">
                {commandLabel}
              </p>
            </div>
            <div>
              <p className="text-[0.625rem] uppercase tracking-wider text-muted-foreground font-medium">
                Physical RF state
              </p>
              <p className="text-sm mt-1 text-muted-foreground">
                Unavailable (TX / listening not measured)
              </p>
            </div>
          </div>
          {(disconnected || !live) && (
            <p className="text-xs text-muted-foreground mt-3">
              {!live
                ? 'Connection to the server is not live; displayed states may be outdated.'
                : 'The radio is disconnected. Waiting operations may be reclassified by the scheduler.'}
            </p>
          )}
        </Section>

        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <Section title="Ongoing operations" count={active.length}>
            {renderJobs(active, 'No scheduled operations in progress.')}
          </Section>
          <Section title="Queued" count={queued.length}>
            <p className="text-xs text-muted-foreground mb-2">
              Estimated order (priority aging); exclusive response sessions may delay dispatch.
            </p>
            {renderJobs(queued, 'No commands waiting for their turn.')}
          </Section>
        </div>

        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <Section title="Received events" count={feed.activity.data?.items.length ?? 0}>
            {feed.activity.data?.gap && (
              <p className="text-xs text-warning mb-3" role="status">
                Event history contains a gap. Older observations are no longer available.
              </p>
            )}
            {feed.activity.isError && (
              <p role="alert" className="text-sm text-destructive">
                Failed to load received activity.
              </p>
            )}
            {(feed.activity.data?.items.length ?? 0) === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">No retained incoming events.</p>
            ) : (
              <ol
                className="min-w-0 max-h-[26rem] overflow-y-auto"
                aria-label="Recent received events"
              >
                {[...(feed.activity.data?.items ?? [])].reverse().map((event) => (
                  <li
                    key={event.sequence}
                    className="flex gap-2 justify-between py-2.5 border-b border-border/70 last:border-0 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{ACTIVITY_LABELS[event.kind]}</span>
                      <span className="block text-muted-foreground text-[0.6875rem]">
                        {ACTIVITY_SOURCES[event.source]}
                      </span>
                    </span>
                    <time
                      className="text-muted-foreground shrink-0 tabular-nums"
                      dateTime={event.at}
                    >
                      {clockTime(event.at)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </Section>
          <Section title="History">
            <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground mb-3">
              Filter outcomes
              <select
                aria-label="Filter job history"
                className="rounded border border-input bg-background text-foreground px-2 py-1.5 text-sm"
                value={filter}
                onChange={(event) => setFilter(event.target.value as HistoryFilter)}
              >
                {FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {historyQuery.isLoading && (
              <p role="status" className="text-xs text-muted-foreground">
                Loading history…
              </p>
            )}
            {historyQuery.isError && (
              <p role="alert" className="text-xs text-destructive">
                Failed to load job history.
              </p>
            )}
            {renderJobs(history, 'No completed or stopped jobs found.')}
            {historyQuery.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                disabled={historyQuery.isFetchingNextPage}
                onClick={() => void historyQuery.fetchNextPage()}
              >
                <ArrowDown className="h-4 w-4 mr-2" aria-hidden="true" />
                {historyQuery.isFetchingNextPage ? 'Loading…' : 'Load older history'}
              </Button>
            )}
          </Section>
        </div>
        <p className="text-xs text-muted-foreground flex gap-2 items-start">
          <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
          The dashboard lists scheduled jobs only. Existing direct radio operations may still use
          the legacy command path until their migration. ACK observation alone does not prove
          delivery; “Unknown” is not “Failed”.
        </p>
      </div>
      <Dialog open={stopJob !== null} onOpenChange={(open) => !open && setStopJob(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock3 className="h-5 w-5" aria-hidden="true" />
              Stop waiting for RF response?
            </DialogTitle>
            <DialogDescription>
              This stops tracking the response only. It cannot retract a command already sent over
              radio. The actual outcome may remain unknown.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopJob(null)}>
              Keep waiting
            </Button>
            <Button
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              disabled={cancel.isPending}
              onClick={() => stopJob && void submitCancel(stopJob)}
            >
              <XCircle className="h-4 w-4 mr-2" aria-hidden="true" />
              Stop waiting
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
