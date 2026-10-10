import { describe, it, expect } from 'vitest';
import { mergeRadioActivity, mergeRadioJob } from './useRadioJobFeed';
import type { components } from '../generated/api-schema';

type Job = components['schemas']['RadioJobSnapshot'];
type Activity = components['schemas']['RadioActivityRecord'];
type JobsPage = components['schemas']['RadioJobsPage'];
type ActivityPage = components['schemas']['RadioActivityPage'];

const job = (version: number, sequence: number): Job => ({
  id: 'af3f3a84-6e46-4d48-a561-d279ab45bbdd',
  kind: 'direct_message',
  state: 'awaiting_ack',
  stage: 'waiting_for_ack',
  priority: 0,
  version,
  sequence,
  radio_generation: 2,
  attempt: 1,
  cancellation_requested: false,
  created_at: '2026-10-10T12:00:00Z',
  updated_at: '2026-10-10T12:00:00Z',
  queue_entered_at: '2026-10-10T12:00:00Z',
  correlation_scope: 'f32c928b-45fa-41b9-ac15-223dab658abf',
});
const activity = (sequence: number): Activity => ({
  sequence,
  kind: 'packet_received',
  source: 'raw_rf_log',
  radio_generation: 2,
  at: '2026-10-10T12:00:00Z',
});
const radio = {
  radio_status: 'connected',
  command_status: 'idle',
  radio_generation: 2,
  sequence: 2,
  physical_rf_state: 'unavailable',
} as const;

describe('radio job feed reconciliation', () => {
  it('deduplicates delayed and duplicate job deltas by ID and version', () => {
    const page: JobsPage = { items: [job(2, 4)], has_more: false, snapshot_sequence: 4, radio };
    expect(mergeRadioJob(page, job(1, 1))).toBe(page);
    const updated = mergeRadioJob(page, job(3, 6))!;
    expect(updated.items).toEqual([job(3, 6)]);
    expect(mergeRadioJob(updated, job(3, 6))).toBe(updated);
  });
  it('sorts received events, deduplicates repeats and bounds replay', () => {
    let page: ActivityPage = {
      items: [activity(3)],
      has_more: false,
      gap: false,
      snapshot_sequence: 3,
      radio,
    };
    page = mergeRadioActivity(page, activity(2))!;
    expect(page.items.map((item) => item.sequence)).toEqual([2, 3]);
    expect(mergeRadioActivity(page, activity(3))).toBe(page);
    for (let i = 4; i < 140; i++) page = mergeRadioActivity(page, activity(i))!;
    expect(page.items).toHaveLength(100);
    expect(page.items[page.items.length - 1]?.sequence).toBe(139);
  });
});
