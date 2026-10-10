/**
 * Query-owned bounded scheduler snapshots. Consumers pass callbacks into the
 * existing app-level useWebSocket connection; this hook does not open a second
 * socket or start polling. Reconnect invalidates both authoritative snapshots.
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../queryClient';
import type { components } from '../generated/api-schema';
import type { RadioActivityDelta, RadioJobDelta } from '../wsEvents';

type JobsPage = components['schemas']['RadioJobsPage'];
type ActivityPage = components['schemas']['RadioActivityPage'];

export function mergeRadioJob(
  page: JobsPage | undefined,
  delta: RadioJobDelta
): JobsPage | undefined {
  if (!page) return page; // Fetch authoritative snapshot on first subscription.
  const existing = page.items.find((item) => item.id === delta.id);
  if (existing && existing.version >= delta.version) return page;
  const items = [delta, ...page.items.filter((item) => item.id !== delta.id)]
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, 100);
  return { ...page, items, snapshot_sequence: Math.max(page.snapshot_sequence, delta.sequence) };
}

export function mergeRadioActivity(
  page: ActivityPage | undefined,
  delta: RadioActivityDelta
): ActivityPage | undefined {
  if (!page || page.items.some((item) => item.sequence === delta.sequence)) return page;
  const items = [...page.items, delta].sort((a, b) => a.sequence - b.sequence).slice(-100);
  return {
    ...page,
    items,
    next_cursor: items[items.length - 1]?.sequence ?? null,
    snapshot_sequence: Math.max(page.snapshot_sequence, delta.sequence),
  };
}

export function useRadioJobFeed() {
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: queryKeys.radioJobs(),
    queryFn: () => api.getRadioJobs({ limit: 100 }),
  });
  const activity = useQuery({
    queryKey: queryKeys.radioActivity(),
    queryFn: () => api.getRadioActivity({ limit: 100 }),
  });

  const onRadioJob = useCallback(
    (job: RadioJobDelta) => {
      const key = queryKeys.radioJobs();
      // Cancel a possibly older HTTP response before it can overwrite a
      // newer WebSocket version. Queue the authoritative refetch if this
      // event raced the very first snapshot.
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      if (!queryClient.getQueryData<JobsPage>(key)) {
        void queryClient.invalidateQueries({ queryKey: key });
      } else {
        queryClient.setQueryData<JobsPage>(key, (page) => mergeRadioJob(page, job));
      }
    },
    [queryClient]
  );

  const onRadioActivity = useCallback(
    (event: RadioActivityDelta) => {
      const key = queryKeys.radioActivity();
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      if (!queryClient.getQueryData<ActivityPage>(key)) {
        void queryClient.invalidateQueries({ queryKey: key });
      } else {
        queryClient.setQueryData<ActivityPage>(key, (page) => mergeRadioActivity(page, event));
      }
    },
    [queryClient]
  );

  const onReconnect = useCallback(() => {
    // Sequence history is bounded; a reconnect may have missed any number of
    // events. Never pretend local WS deltas alone are authoritative.
    void queryClient.invalidateQueries({ queryKey: queryKeys.radioJobs() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.radioActivity() });
  }, [queryClient]);

  return { jobs, activity, onRadioJob, onRadioActivity, onReconnect };
}
