import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '../generated/api-schema';
import { jobDuration } from '../components/RadioActivityPage';

type Job = components['schemas']['RadioJobSnapshot'];

const START = '2026-01-01T00:00:00.000Z';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'radio_query',
    priority: 10,
    state: 'completed',
    stage: 'finished',
    attempt: 1,
    cancellation_requested: false,
    correlation_scope: '00000000-0000-0000-0000-000000000002',
    created_at: START,
    queue_entered_at: START,
    started_at: START,
    completed_at: '2026-01-01T00:00:10.000Z',
    updated_at: '2026-01-01T00:00:10.000Z',
    radio_generation: 1,
    sequence: 1,
    version: 1,
    ...overrides,
  };
}

describe('radio job durations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:20.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it.each(['completed', 'failed', 'cancelled', 'unknown'] as const)(
    'freezes %s jobs at completed_at',
    (state) => {
      const job = makeJob({ state });

      expect(jobDuration(job, Date.now())).toBe('10s');
      vi.advanceTimersByTime(60_000);
      expect(jobDuration(job, Date.now())).toBe('10s');
    }
  );

  it('shows queue wait for a cancellation that never started', () => {
    const job = makeJob({
      state: 'cancelled',
      stage: 'cancelled',
      started_at: null,
      completed_at: '2026-01-01T00:00:07.000Z',
      updated_at: '2026-01-01T00:00:07.000Z',
    });

    expect(jobDuration(job, Date.now())).toBe('7s');
  });

  it.each(['executing', 'awaiting_response', 'awaiting_ack'] as const)(
    'keeps %s jobs live until they become terminal',
    (state) => {
      const job = makeJob({ state, completed_at: null, updated_at: START });

      expect(jobDuration(job, Date.now())).toBe('20s');
      vi.advanceTimersByTime(5_000);
      expect(jobDuration(job, Date.now())).toBe('25s');
    }
  );

  it('uses the immutable updated_at fallback for legacy terminal snapshots', () => {
    const job = makeJob({ completed_at: null });

    expect(jobDuration(job, Date.now())).toBe('10s');
    vi.advanceTimersByTime(5_000);
    expect(jobDuration(job, Date.now())).toBe('10s');
  });

  it('handles invalid and future timestamps without NaN or negative durations', () => {
    expect(jobDuration(makeJob({ started_at: 'not-a-date' }), Date.now())).toBe('—');
    expect(
      jobDuration(
        makeJob({ started_at: '2026-01-01T00:01:00.000Z', completed_at: null }),
        Date.now()
      )
    ).toBe('0s');
    expect(
      jobDuration(
        makeJob({
          started_at: '2026-01-01T00:00:15.000Z',
          completed_at: '2026-01-01T00:00:10.000Z',
        }),
        Date.now()
      )
    ).toBe('0s');
  });
});
