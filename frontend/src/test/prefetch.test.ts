import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../queryClient';

interface PrefetchWindow extends Window {
  __prefetch?: unknown;
}

function setPrefetchStore(store: unknown) {
  (window as PrefetchWindow).__prefetch = store;
}

describe('takePrefetchOrFetch', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as PrefetchWindow).__prefetch;
    vi.restoreAllMocks();
  });

  it('uses prefetched data once, then falls back', async () => {
    setPrefetchStore({
      undecryptedCount: Promise.resolve({ count: 7 }),
    });

    const { takePrefetchOrFetch } = await import('../prefetch');
    const fallback = vi.fn().mockResolvedValue({ count: 9 });

    await expect(takePrefetchOrFetch('undecryptedCount', fallback)).resolves.toEqual({ count: 7 });
    expect(fallback).not.toHaveBeenCalled();

    await expect(takePrefetchOrFetch('undecryptedCount', fallback)).resolves.toEqual({ count: 9 });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when prefetched promise rejects', async () => {
    const prefetchedFailure = Promise.reject(new Error('prefetch failed'));
    // Avoid unhandled rejection noise while the helper awaits the same promise.
    prefetchedFailure.catch(() => undefined);
    setPrefetchStore({
      undecryptedCount: prefetchedFailure,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { takePrefetchOrFetch } = await import('../prefetch');
    const fallback = vi.fn().mockResolvedValue({ count: 11 });

    await expect(takePrefetchOrFetch('undecryptedCount', fallback)).resolves.toEqual({ count: 11 });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('adopts bootstrap promises into the Query cache', async () => {
    const unreads = {
      counts: {},
      mentions: {},
      last_message_times: {},
      first_unread_ids: {},
      last_read_ats: {},
    };
    setPrefetchStore({
      config: Promise.resolve({ public_key: 'local' }),
      settings: Promise.resolve({}),
      channels: Promise.resolve([]),
      contacts: Promise.resolve([]),
      unreads: Promise.resolve(unreads),
      undecryptedCount: Promise.resolve({ count: 7 }),
    });

    const { primePrefetchCache } = await import('../prefetch');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    primePrefetchCache(queryClient);

    await vi.waitFor(() => {
      expect(queryClient.getQueryData(queryKeys.radioConfig())).toEqual({ public_key: 'local' });
      expect(queryClient.getQueryData(queryKeys.unreads())).toEqual(unreads);
      expect(queryClient.getQueryData(queryKeys.undecryptedCount())).toEqual({ count: 7 });
    });
  });
});
