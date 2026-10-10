/**
 * Consume prefetched API promises started in index.html before React loaded.
 *
 * Each key is consumed at most once — the first caller gets the promise,
 * subsequent callers get undefined and should fall back to a normal fetch.
 */

import type { AppSettings, Channel, Contact, RadioConfig, UnreadCounts } from './types';
import type { QueryClient } from '@tanstack/react-query';
import { api } from './api';
import { queryKeys } from './queryClient';

interface PrefetchMap {
  config: Promise<RadioConfig>;
  settings: Promise<AppSettings>;
  channels: Promise<Channel[]>;
  contacts: Promise<Contact[]>;
  unreads: Promise<UnreadCounts>;
  undecryptedCount: Promise<{ count: number }>;
}

const store: Partial<PrefetchMap> =
  (window as unknown as { __prefetch?: Partial<PrefetchMap> }).__prefetch ?? {};

type PrefetchResolved<K extends keyof PrefetchMap> = Awaited<PrefetchMap[K]>;

/** Take a prefetched promise (consumed once, then gone). */
function takePrefetch<K extends keyof PrefetchMap>(key: K): PrefetchMap[K] | undefined {
  const p = store[key];
  delete store[key];
  return p;
}

/**
 * Use prefetched data when available. If prefetch failed or was absent, run
 * the provided fallback fetcher.
 */
export async function takePrefetchOrFetch<K extends keyof PrefetchMap>(
  key: K,
  fallback: () => Promise<PrefetchResolved<K>>
): Promise<PrefetchResolved<K>> {
  const prefetched = takePrefetch(key);
  if (!prefetched) {
    return fallback();
  }

  try {
    return (await prefetched) as PrefetchResolved<K>;
  } catch (err) {
    console.warn(`Prefetch for "${String(key)}" failed, falling back to live fetch.`, err);
    return fallback();
  }
}

/** Fetch every contact while retaining the head-start from index.html. */
export async function fetchAllContacts(signal?: AbortSignal): Promise<Contact[]> {
  const pageSize = 1000;
  const first = await takePrefetchOrFetch('contacts', () => api.getContacts(pageSize, 0, signal));
  if (first.length < pageSize) return first;

  let all = [...first];
  for (let offset = pageSize; ; offset += pageSize) {
    const page = await api.getContacts(pageSize, offset, signal);
    all = all.concat(page);
    if (page.length < pageSize) return all;
  }
}

/**
 * Adopt the early browser requests into Query before hooks mount. Query deduplicates
 * against these in-flight promises, so bootstrap speed is retained without a second cache.
 */
export function primePrefetchCache(queryClient: QueryClient): void {
  const prime = <T>(queryKey: readonly unknown[], queryFn: () => Promise<T>) => {
    void queryClient.prefetchQuery({ queryKey, queryFn });
  };

  prime(queryKeys.radioConfig(), () => takePrefetchOrFetch('config', api.getRadioConfig));
  prime(queryKeys.settings(), () => takePrefetchOrFetch('settings', () => api.getSettings()));
  prime(queryKeys.channels(), () => takePrefetchOrFetch('channels', () => api.getChannels()));
  prime(queryKeys.contacts(), () => fetchAllContacts());
  prime(queryKeys.unreads(), () => takePrefetchOrFetch('unreads', api.getUnreads));
  prime(queryKeys.undecryptedCount(), () =>
    takePrefetchOrFetch('undecryptedCount', api.getUndecryptedPacketCount)
  );
}
