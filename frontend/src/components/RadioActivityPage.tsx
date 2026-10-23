import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { getLocale } from '@/i18n';
/** Radio Activity is an observer of the *one* process-owned radio, not a radio controller. */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Clock3, RadioTower, RefreshCw, XCircle } from 'lucide-react';
import type { components } from '../generated/api-schema';
import type { HealthStatus } from '../types';
import { type HistoryFilter, type RadioJobFeed, useRadioActivity } from '../hooks/useRadioActivity';
import {
  measureElementWithFallback,
  observeElementRectWithFallback,
} from '../utils/virtualization';
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

const JOB_NAMES: Record<Job['kind'], () => string> = {
  direct_message: () => t`Direct message`,
  channel_message: () => t`Channel message`,
  repeater_login: () => t`Repeater login`,
  room_login: () => t`Room login`,
  radio_settings: () => t`Radio settings`,
  advertisement: () => t`Advertisement`,
  discovery: () => t`Discovery`,
  trace: () => t`Route trace`,
  server_query: () => t`Repeater / room query`,
  contact_query: () => t`Contact query`,
  radio_query: () => t`Radio query`,
  companion_local_cli: () => t`Local Companion CLI (on device)`,
  remote_companion_cli: () => t`Remote Companion CLI (RF request)`,
  channel_datagram: () => t`Channel datagram (RF request)`,
  radio_diagnostics: () => t`Radio diagnostics (read-only)`,
  periodic_sync: () => t`Periodic sync`,
  radio_stats_sample: () => t`Radio stats sample`,
  periodic_advertisement: () => t`Periodic advertisement`,
  lifecycle_device_info: () => t`Startup device info`,
  lifecycle_key_export: () => t`Startup key export`,
  lifecycle_clock_sync: () => t`Startup clock sync`,
  lifecycle_flood_scope: () => t`Startup flood scope`,
  lifecycle_contact_sync: () => t`Startup contact sync`,
  lifecycle_channel_sync: () => t`Startup channel sync`,
  lifecycle_channel_clear: () => t`Startup channel clear`,
  lifecycle_advertisement: () => t`Startup advertisement`,
  lifecycle_message_drain: () => t`Startup message drain`,
  lifecycle_auto_fetch: () => t`Startup receive service`,
};
const STATES: Record<Job['state'], () => string> = {
  queued: () => t`Queued`,
  executing: () => t`Executing command`,
  awaiting_response: () => t`Waiting for response`,
  awaiting_ack: () => t`Waiting for ACK`,
  retrying: () => t`Retry pending`,
  completed: () => t`Completed`,
  failed: () => t`Failed`,
  cancelled: () => t`Cancelled`,
  unknown: () => t`Outcome unknown`,
};
const STAGES: Record<Job['stage'], () => string> = {
  waiting_turn: () => t`Waiting for command turn`,
  transport_command: () => t`Sending command to radio`,
  waiting_for_response: () => t`Waiting for RF reply`,
  waiting_for_ack: () => t`Awaiting RF acknowledgment`,
  retry_pending: () => t`Retry pending`,
  finished: () => t`Command or response confirmed`,
  failed: () => t`Operation failed`,
  cancelled: () => t`Operation cancelled`,
  uncertain: () => t`Transmission outcome uncertain`,
};
const ACTIVITY_LABELS: Record<ActivityRecord['kind'], () => string> = {
  packet_received: () => t`Packet received`,
  ack_observed: () => t`ACK observed`,
  contact_message_observed: () => t`Contact message observed`,
  path_update: () => t`Path update observed`,
  contact_observed: () => t`Contact observed`,
  login_response: () => t`Login response observed`,
  cli_response: () => t`CLI response observed`,
  connection_changed: () => t`Radio connection changed`,
};
const PACKET_TYPES: Record<NonNullable<ActivityRecord['packet_type']>, () => string> = {
  channel: () => t`Channel message`,
  direct: () => t`Direct message`,
  advertisement: () => t`Advertisement`,
  ack: () => t`Acknowledgment`,
  path: () => t`Path / route`,
  control: () => t`Control packet`,
  other: () => t`Unknown or encrypted packet`,
};
const BACKGROUND_JOBS = new Set<Job['kind']>([
  'periodic_sync',
  'periodic_advertisement',
  'radio_stats_sample',
]);
const TERMINAL = new Set<Job['state']>(['completed', 'failed', 'cancelled', 'unknown']);
const ACTIVITY_SOURCES: Record<ActivityRecord['source'], () => string> = {
  raw_rf_log: () => t`Packet log`,
  meshcore_event: () => t`Radio event`,
  radio_lifecycle: () => t`Connection`,
};
const FILTERS: { value: HistoryFilter; label: string }[] = [
  {
    value: 'all',
    get label() {
      return t`All outcomes`;
    },
  },
  {
    value: 'completed',
    get label() {
      return t`Completed`;
    },
  },
  {
    value: 'failed',
    get label() {
      return t`Failed`;
    },
  },
  {
    value: 'cancelled',
    get label() {
      return t`Cancelled`;
    },
  },
  {
    value: 'unknown',
    get label() {
      return t`Unknown`;
    },
  },
];

export function elapsed(start: string, now: number): string {
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs) || !Number.isFinite(now)) return '—';
  const secs = Math.max(0, Math.floor((now - startMs) / 1000));
  if (!Number.isFinite(secs)) return '—';
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function jobDuration(job: Job, now: number): string {
  // A finished job's duration is immutable. A job cancelled before dispatch
  // spent time in the queue, not executing a command.
  const end = TERMINAL.has(job.state) ? Date.parse(job.completed_at ?? job.updated_at) : now;
  return elapsed(job.started_at ?? job.queue_entered_at, end);
}

function clockTime(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.valueOf()) ? '—' : parsed.toLocaleTimeString(getLocale());
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
  compact = false,
  children,
}: {
  title: string;
  count?: number;
  compact?: boolean;
  children: React.ReactNode;
}) {
  useLingui();

  return (
    <section
      className={cn('min-w-0', compact ? 'py-2' : 'rounded-lg border border-border bg-card')}
      aria-label={title}
    >
      <h3
        className={cn(
          'text-base font-semibold tracking-tight flex gap-2 items-center',
          compact ? 'px-1 py-1' : 'px-4 py-3 border-b border-border'
        )}
      >
        {title}
        {count !== undefined && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
            {count}
          </span>
        )}
      </h3>
      <div className={compact ? `px-1` : `p-3 sm:p-4`}>{children}</div>
    </section>
  );
}

function JobRow({
  job,
  now,
  onCancel,
  pending,
  measureRef,
  dataIndex,
  style,
}: {
  job: Job;
  now: number;
  onCancel: (job: Job) => void;
  pending: boolean;
  measureRef?: (element: HTMLLIElement | null) => void;
  dataIndex?: number;
  style?: CSSProperties;
}) {
  useLingui();

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
    <li
      ref={measureRef}
      data-index={dataIndex}
      style={style}
      className={cn(
        'border-b border-border/70 last:border-b-0 py-3 first:pt-0 last:pb-0 min-w-0',
        style && 'absolute left-0 top-0 w-full'
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{JOB_NAMES[job.kind]()}</p>
          <p className={cn('text-xs mt-0.5', stateClass(job.state))}>{STATES[job.state]()}</p>
          {(job.state === 'executing' || awaiting || job.state === 'retrying') && (
            <p className="text-sm text-muted-foreground mt-1">{STAGES[job.stage]()}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1 tabular-nums">
            {job.state === 'queued' || !job.started_at ? t`Queue wait` : t`Duration`}:{' '}
            {jobDuration(job, now)}
            {!TERMINAL.has(job.state) &&
              t` · ${job.priority === 0 ? t`High` : job.priority === 10 ? t`Normal` : t`Low`} priority`}
            {job.attempt > 1 ? t` · Attempt ${job.attempt}` : ''}
          </p>
          {deadline && !TERMINAL.has(job.state) && (
            <p className="text-xs text-muted-foreground tabular-nums">
              <Trans>Deadline: {clockTime(deadline)}</Trans>
            </p>
          )}
          {job.state === 'executing' && (
            <p className="text-xs text-muted-foreground">
              <Trans>Cancellation is best-effort; an in-flight command may still execute.</Trans>
            </p>
          )}
          {job.result && job.state !== 'completed' && (
            <p className="text-xs text-muted-foreground mt-1">{job.result.replace(/_/g, ' ')}</p>
          )}
        </div>
        {cancellable && (
          <Button
            variant="outline"
            size="sm"
            disabled={pending || job.cancellation_requested}
            onClick={() => onCancel(job)}
            aria-label={t`${awaiting ? t`Stop waiting for` : job.state === 'executing' ? t`Request cancellation of` : t`Cancel`} ${JOB_NAMES[job.kind]()}`}
          >
            {pending
              ? t`Working…`
              : job.cancellation_requested
                ? t`Requested`
                : awaiting
                  ? t`Stop waiting`
                  : job.state === 'executing'
                    ? t`Request cancellation`
                    : t`Cancel job`}
          </Button>
        )}
      </div>
    </li>
  );
}

function VirtualJobHistory({
  jobs,
  emptyText,
  now,
  onCancel,
  pendingJobId,
}: {
  jobs: Job[];
  emptyText: string;
  now: number;
  onCancel: (job: Job) => void;
  pendingJobId: string | null;
}) {
  useLingui();

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: jobs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    getItemKey: (index) => jobs[index]?.id ?? `job-${index}`,
    overscan: 6,
    measureElement: measureElementWithFallback(() => 92),
    observeElementRect: observeElementRectWithFallback(416),
  });

  return (
    <div
      ref={scrollRef}
      className="max-h-[26rem] min-w-0 overflow-y-auto overscroll-y-auto rounded-sm [contain:layout_paint] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="group"
      aria-label={t`Job history list`}
      tabIndex={jobs.length > 0 ? 0 : undefined}
    >
      {jobs.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="relative min-w-0" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const job = jobs[virtualRow.index];
            if (!job) return null;
            return (
              <JobRow
                key={virtualRow.key}
                job={job}
                now={now}
                onCancel={onCancel}
                pending={pendingJobId === job.id}
                measureRef={virtualizer.measureElement}
                dataIndex={virtualRow.index}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function VirtualActivityList({ events }: { events: ActivityRecord[] }) {
  useLingui();

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    getItemKey: (index) => events[index]?.sequence ?? `activity-${index}`,
    overscan: 8,
    measureElement: measureElementWithFallback(() => 58),
    observeElementRect: observeElementRectWithFallback(416),
  });

  return (
    <div
      ref={scrollRef}
      className="min-w-0 max-h-[26rem] overflow-y-auto overscroll-y-auto rounded-sm [contain:layout_paint] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="list"
      aria-label={t`Recent received events`}
      tabIndex={events.length > 0 ? 0 : undefined}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const event = events[virtualRow.index];
          if (!event) return null;
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              role="listitem"
              className="absolute left-0 top-0 flex w-full gap-2 justify-between py-2.5 border-b border-border/70 text-xs"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <span className="min-w-0">
                <span className="font-medium">
                  {event.kind === 'packet_received' && event.packet_type
                    ? PACKET_TYPES[event.packet_type]()
                    : ACTIVITY_LABELS[event.kind]()}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {event.kind === 'packet_received'
                    ? [
                        event.hops != null ? `${event.hops} hops` : null,
                        event.rssi != null ? `${event.rssi} dBm` : null,
                        event.snr != null ? `SNR ${event.snr} dB` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || t`Sender unavailable`
                    : event.kind === 'connection_changed' && event.readiness
                      ? t`${event.previous_readiness ?? 'unknown'} → ${event.readiness} · generation ${event.radio_generation}`
                      : ACTIVITY_SOURCES[event.source]()}
                </span>
              </span>
              <time className="text-muted-foreground shrink-0 tabular-nums" dateTime={event.at}>
                {clockTime(event.at)}
              </time>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RadioActivityPage({ feed, connection, health }: Props) {
  useLingui();

  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [showBackground, setShowBackground] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [stopJob, setStopJob] = useState<Job | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const { active, queued, history, historyQuery, cancel } = useRadioActivity(feed, filter, now);
  const visibleHistory = showBackground
    ? history
    : history.filter((job) => !BACKGROUND_JOBS.has(job.kind) || job.state !== 'completed');

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
      ? (health.radio_state ?? (health.radio_connected ? 'ready' : 'disconnected'))
      : radio?.radio_status;
  const disconnected = radioConnection === 'disconnected';
  const commandLabel = disconnected
    ? t`Disconnected`
    : radioConnection === 'connecting' || radioConnection === 'initializing'
      ? t`Connecting`
      : radioConnection === 'failed'
        ? t`Recovery required`
        : !radio
          ? t`Loading status…`
          : executing
            ? t`Executing ${JOB_NAMES[executing.kind]()} command`
            : radio.command_status === 'legacy_busy'
              ? t`Legacy command in progress`
              : t`Idle`;
  const status =
    radioConnection === 'ready' || radioConnection === 'connected'
      ? t`Ready`
      : radioConnection === 'degraded'
        ? t`Degraded`
        : radioConnection === 'failed'
          ? t`Failed`
          : radioConnection === 'connecting' || radioConnection === 'initializing'
            ? t`Initializing`
            : radioConnection === 'paused'
              ? t`Paused`
              : t`Disconnected`;

  async function submitCancel(job: Job) {
    setStopJob(null);
    setCancelError(null);
    try {
      await cancel.mutateAsync(job.id);
    } catch {
      setCancelError(t`Could not update the job. Refresh the snapshot to check its current state.`);
    }
  }

  function handleCancel(job: Job) {
    if (job.state === 'awaiting_ack' || job.state === 'awaiting_response') {
      setStopJob(job);
    } else {
      void submitCancel(job);
    }
  }

  async function refreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.allSettled([
        feed.jobs.refetch(),
        feed.activity.refetch(),
        historyQuery.refetch(),
      ]);
    } finally {
      setRefreshing(false);
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
      aria-label={t`Radio Activity dashboard`}
      aria-busy={refreshing}
    >
      <div className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-5 pb-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <RadioTower className="h-5 w-5 text-primary" aria-hidden="true" />
              <Trans>Radio Activity</Trans>
            </h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshAll()}
            disabled={refreshing}
            aria-label={t`Refresh radio activity`}
          >
            <RefreshCw
              className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')}
              aria-hidden="true"
            />
            {refreshing ? t`Refreshing…` : t`Refresh`}
          </Button>
        </div>
        {connection !== 'live' && (
          <p aria-live="polite" role="status" className="text-sm text-warning">
            {connection === 'connecting'
              ? t`Connecting to live updates…`
              : t`Offline — snapshots may be stale. Reconnecting…`}
          </p>
        )}
        {feed.jobs.isLoading && (
          <p role="status" className="text-sm">
            <Trans>Loading radio jobs…</Trans>
          </p>
        )}
        {feed.jobs.isError && (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Could not load radio jobs. Try Refresh.</Trans>
          </p>
        )}
        {cancelError && (
          <p role="alert" className="text-sm text-destructive">
            {cancelError}
          </p>
        )}

        <section aria-label={t`Radio now`} className="rounded-lg border border-border p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <div>
                <span className="text-sm text-muted-foreground mr-2">
                  <Trans>Radio</Trans>
                </span>
                <strong className="text-sm">{radioConnection ? status : t`Checking…`}</strong>
              </div>
              <div aria-live="polite">
                <span className="text-sm text-muted-foreground mr-2">
                  <Trans>Command</Trans>
                </span>
                <strong className="text-sm font-medium">{commandLabel}</strong>
              </div>
            </div>
            <span className="text-xs text-muted-foreground">
              <Trans>
                RF TX/RX unmeasured · {health?.startup_policy ?? radio?.startup_policy ?? 'full'}{' '}
                startup
              </Trans>
            </span>
          </div>
          {(disconnected || !live) && (
            <p className="text-sm text-warning mt-2">
              {!live
                ? t`Connection to the server is not live; displayed states may be outdated.`
                : t`Radio disconnected. Pending operations may have unknown outcomes.`}
            </p>
          )}
        </section>

        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <Section
            title={t`Ongoing operations`}
            count={active.length}
            compact={active.length === 0}
          >
            {renderJobs(active, 'No ongoing operations')}
          </Section>
          <Section title={t`Queued`} count={queued.length} compact={queued.length === 0}>
            {renderJobs(queued, 'No queued commands')}
          </Section>
        </div>

        <div className="grid lg:grid-cols-2 gap-4 items-start">
          <Section title={t`Received events`} count={feed.activity.data?.items.length ?? 0}>
            {feed.activity.data?.gap && (
              <p className="text-xs text-warning mb-3" role="status">
                <Trans>
                  Event history contains a gap. Older observations are no longer available.
                </Trans>
              </p>
            )}
            {feed.activity.isError && (
              <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-destructive">
                  <Trans>Failed to load received activity.</Trans>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void feed.activity.refetch()}
                  disabled={feed.activity.isFetching}
                >
                  {feed.activity.isFetching ? t`Retrying…` : t`Retry`}
                </Button>
                {(feed.activity.data?.items.length ?? 0) > 0 && (
                  <span className="w-full text-xs text-warning">
                    <Trans>Showing retained stale events.</Trans>
                  </span>
                )}
              </div>
            )}
            {!feed.activity.isError && (feed.activity.data?.items.length ?? 0) === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                <Trans>No retained incoming events.</Trans>
              </p>
            ) : (feed.activity.data?.items.length ?? 0) > 0 ? (
              <VirtualActivityList events={[...(feed.activity.data?.items ?? [])].reverse()} />
            ) : null}
          </Section>
          <Section title={t`History`}>
            <label className="flex items-center justify-between gap-2 text-sm text-muted-foreground mb-3">
              <Trans>Filter outcomes</Trans>
              <select
                aria-label={t`Filter job history`}
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
                <Trans>Loading history…</Trans>
              </p>
            )}
            {historyQuery.isError && (
              <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-destructive">
                  <Trans>Failed to load job history.</Trans>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void historyQuery.refetch()}
                  disabled={historyQuery.isFetching}
                >
                  {historyQuery.isFetching ? t`Retrying…` : t`Retry`}
                </Button>
                {visibleHistory.length > 0 && (
                  <span className="w-full text-xs text-warning">
                    <Trans>Showing retained stale jobs.</Trans>
                  </span>
                )}
              </div>
            )}
            <label className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={showBackground}
                onChange={(event) => setShowBackground(event.target.checked)}
              />
              <Trans>Include routine background jobs</Trans>
            </label>
            {(!historyQuery.isError || visibleHistory.length > 0) && (
              <VirtualJobHistory
                key={`${filter}:${showBackground}`}
                jobs={visibleHistory}
                emptyText={t`No matching history. Enable background jobs to see routine samples.`}
                now={now}
                onCancel={handleCancel}
                pendingJobId={cancel.isPending ? (cancel.variables ?? null) : null}
              />
            )}
            {historyQuery.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                disabled={historyQuery.isFetchingNextPage}
                onClick={() => void historyQuery.fetchNextPage()}
              >
                <ArrowDown className="h-4 w-4 mr-2" aria-hidden="true" />
                {historyQuery.isFetchingNextPage ? t`Loading…` : t`Load older history`}
              </Button>
            )}
          </Section>
        </div>
      </div>
      <Dialog open={stopJob !== null} onOpenChange={(open) => !open && setStopJob(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock3 className="h-5 w-5" aria-hidden="true" />
              <Trans>Stop waiting for RF response?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                This stops tracking the response only. It cannot retract a command already sent over
                radio. The actual outcome may remain unknown.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopJob(null)}>
              <Trans>Keep waiting</Trans>
            </Button>
            <Button
              variant="outline"
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              disabled={cancel.isPending}
              onClick={() => stopJob && void submitCancel(stopJob)}
            >
              <XCircle className="h-4 w-4 mr-2" aria-hidden="true" />
              <Trans>Stop waiting</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
