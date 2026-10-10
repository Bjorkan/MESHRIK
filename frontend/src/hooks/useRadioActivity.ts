/**
 * Radio Activity view model: Query owns paginated history and command cancellation.
 * Live snapshots and WebSocket replay are managed by useRadioJobFeed in App.
 * Do not persist job records, private payloads or a second event cache here.
 */
import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../queryClient';
import type { components } from '../generated/api-schema';
import { mergeRadioJob, type useRadioJobFeed } from './useRadioJobFeed';

type Job = components['schemas']['RadioJobSnapshot'];
export type HistoryFilter = 'all' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type RadioJobFeed = ReturnType<typeof useRadioJobFeed>;

const ongoingStates = new Set<Job['state']>([
  'executing',
  'awaiting_response',
  'awaiting_ack',
  'retrying',
]);
const terminalStates = new Set<Job['state']>(['completed', 'failed', 'cancelled', 'unknown']);

/** Never show stale versions or double-count a job present in both pages and WS. */
export function reconcileRadioJobs(...sources: readonly Job[][]): Job[] {
  const byId = new Map<string, Job>();
  for (const source of sources) {
    for (const job of source) {
      const previous = byId.get(job.id);
      if (
        !previous ||
        job.version > previous.version ||
        (job.version === previous.version && job.sequence > previous.sequence)
      ) {
        byId.set(job.id, job);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.sequence - a.sequence);
}

export function partitionRadioJobs(jobs: readonly Job[], now = Date.now()) {
  const active = jobs.filter((job) => ongoingStates.has(job.state));
  // Mirror the scheduler's 30-second aging policy (#38). This is an estimated
  // selection order; protocol-specific exclusive sessions may delay dispatch.
  const rank = (job: Job) =>
    job.priority - 10 * Math.max(0, Math.floor((now - Date.parse(job.queue_entered_at)) / 30_000));
  const queued = jobs
    .filter((job) => job.state === 'queued')
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || a.sequence - b.sequence);
  const history = jobs.filter((job) => terminalStates.has(job.state));
  return { active, queued, history };
}

export function useRadioActivity(feed: RadioJobFeed, filter: HistoryFilter, now: number) {
  const queryClient = useQueryClient();
  const history = useInfiniteQuery({
    queryKey: [...queryKeys.radioJobs(), 'history', filter] as const,
    initialPageParam: undefined as number | undefined,
    // Keep history bounded in memory as well as on the server.
    maxPages: 5,
    queryFn: ({ pageParam }) =>
      api.getRadioJobs({
        status: filter === 'all' ? undefined : filter,
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => (page.has_more ? (page.next_cursor ?? undefined) : undefined),
  });

  const cancel = useMutation({
    mutationFn: (jobId: string) => api.cancelRadioJob(jobId),
    // Cancellation is never automatically retried: the command may already be in flight.
    retry: false,
    onSuccess: ({ job }) => {
      queryClient.setQueryData(queryKeys.radioJobs(), (page: Parameters<typeof mergeRadioJob>[0]) =>
        mergeRadioJob(page, job)
      );
      // History uses separate cursor-based pages. A cancelled job may have changed
      // status/position; refetch instead of mutating cursor order locally.
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.radioJobs(), 'history'] });
    },
  });

  const jobs = useMemo(() => {
    const pages = history.data?.pages.flatMap((page) => page.items) ?? [];
    return reconcileRadioJobs(feed.jobs.data?.items ?? [], pages);
  }, [feed.jobs.data?.items, history.data?.pages]);

  const grouped = useMemo(() => partitionRadioJobs(jobs, now), [jobs, now]);
  return {
    ...grouped,
    history: grouped.history.filter((job) => filter === 'all' || job.state === filter),
    historyQuery: history,
    cancel,
  };
}
