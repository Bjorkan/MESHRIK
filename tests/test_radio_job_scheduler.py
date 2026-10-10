"""Deterministic, hardware-free lifecycle tests for issues #38 and #39."""

import asyncio
import hashlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.services.radio_job_scheduler import (
    RadioIdempotencyConflict,
    RadioJobScheduler,
    RadioQueueFullError,
    RadioQueueUnavailableError,
)
from app.services.radio_job_worker import (
    RadioCommandOutcome,
    RadioJobWorker,
    RadioProcessLease,
)
from app.services.radio_jobs import (
    InvalidJobTransition,
    RadioJobKind,
    RadioJobPriority,
    RadioJobResult,
    RadioJobState,
)


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 10, tzinfo=UTC)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


def test_fifo_priority_fairness_and_fake_clock():
    clock = Clock()
    queue = RadioJobScheduler(clock=clock, aging_seconds=10)
    normal1 = queue.submit(RadioJobKind.RADIO_QUERY)
    normal2 = queue.submit(RadioJobKind.RADIO_QUERY)
    low = queue.submit(RadioJobKind.PERIODIC_SYNC, priority=RadioJobPriority.LOW)
    high = queue.submit(RadioJobKind.DISCOVERY, priority=RadioJobPriority.HIGH)

    for job in (high, normal1, normal2):
        assert queue.take_next().id == job.id
        assert queue.take_next() is None  # the permit is still occupied
        queue.transition(job.id, RadioJobState.COMPLETED)
    # Older low-priority work eventually overtakes newly admitted high-priority work.
    clock.advance(32)
    new_high = queue.submit(RadioJobKind.DISCOVERY, priority=RadioJobPriority.HIGH)
    assert queue.take_next().id == low.id
    queue.transition(low.id, RadioJobState.COMPLETED)
    assert queue.take_next().id == new_high.id
    assert queue.queue_size == 0
    assert queue.take_next() is None


def test_bounded_capacity_expires_and_reopens():
    clock = Clock()
    queue = RadioJobScheduler(capacity=1, clock=clock)
    job = queue.submit(RadioJobKind.RADIO_QUERY, queue_timeout_seconds=3)
    with pytest.raises(RadioQueueFullError) as exc:
        queue.submit(RadioJobKind.DISCOVERY)
    assert exc.value.status_code == 503
    assert exc.value.retry_after_seconds == 5
    clock.advance(4)
    next_job = queue.submit(RadioJobKind.DISCOVERY)
    assert queue.get(job.id).state == RadioJobState.FAILED
    assert queue.get(job.id).result == RadioJobResult.QUEUE_EXPIRED
    assert queue.take_next().id == next_job.id
    assert queue.get(next_job.id).command_deadline is not None


def test_state_machine_terminals_versions_and_bounded_events():
    clock = Clock()
    queue = RadioJobScheduler(clock=clock, event_limit=3)
    job = queue.submit(RadioJobKind.DIRECT_MESSAGE)
    executing = queue.take_next()
    assert executing.id == job.id
    waiting = queue.transition(job.id, RadioJobState.AWAITING_ACK)
    assert waiting.response_deadline == clock.now + timedelta(seconds=30)
    assert waiting.command_deadline is not None
    assert waiting.version == 3
    assert [e.sequence for e in queue.events_since()] == [1, 2, 3]
    assert [s.version for s in (job, executing, waiting)] == [1, 2, 3]
    clock.advance(30)
    queue.sweep()
    final = queue.get(job.id)
    assert final.state == RadioJobState.UNKNOWN
    assert final.result == RadioJobResult.RESPONSE_EXPIRED
    assert final.completed_at is not None
    assert [e.sequence for e in queue.events_since()] == [2, 3, 4]
    with pytest.raises(InvalidJobTransition):
        queue.transition(job.id, RadioJobState.COMPLETED)
    with pytest.raises(InvalidJobTransition):
        queue.transition(job.id, RadioJobState.UNKNOWN)


def test_idempotency_validates_kind_scope_and_fingerprint_and_coalesces():
    queue = RadioJobScheduler(capacity=2)
    fingerprint = hashlib.sha256(b"internal normalized request").hexdigest()
    first = queue.submit(
        RadioJobKind.DIRECT_MESSAGE,
        scope="opaque-target-id",
        idempotency_key="request-1",
        request_fingerprint=fingerprint,
    )
    replay = queue.submit(
        RadioJobKind.DIRECT_MESSAGE,
        scope="opaque-target-id",
        idempotency_key="request-1",
        request_fingerprint=fingerprint,
    )
    assert replay.id == first.id
    with pytest.raises(RadioIdempotencyConflict):
        queue.submit(
            RadioJobKind.CHANNEL_MESSAGE,
            scope="opaque-target-id",
            idempotency_key="request-1",
            request_fingerprint=fingerprint,
        )
    with pytest.raises(RadioIdempotencyConflict):
        queue.submit(
            RadioJobKind.DIRECT_MESSAGE,
            scope="opaque-target-id",
            idempotency_key="request-1",
            request_fingerprint="1" * 64,
        )
    with pytest.raises(ValueError, match="SHA-256"):
        queue.submit(RadioJobKind.DIRECT_MESSAGE, idempotency_key="missing fingerprint")

    periodic = queue.submit(RadioJobKind.PERIODIC_SYNC, coalesce_key="periodic")
    assert queue.submit(RadioJobKind.PERIODIC_SYNC, coalesce_key="periodic").id == periodic.id
    assert queue.queue_size == 2


def test_private_data_never_serializes_and_history_is_bounded():
    queue = RadioJobScheduler(history_limit=1)
    password = "super-private-password"
    message = "the private message body"
    key = "abcdef" * 20
    job = queue.submit(
        RadioJobKind.REPEATER_LOGIN,
        scope=password,
        idempotency_key=key,
        request_fingerprint=hashlib.sha256(message.encode()).hexdigest(),
    )
    serialized = job.model_dump_json()
    events = str([e.model_dump() for e in queue.events_since()])
    for secret in (password, message, key):
        assert secret not in serialized
        assert secret not in events
    assert '"kind":"repeater_login"' in serialized
    queue.request_cancellation(job.id)
    second = queue.submit(RadioJobKind.RADIO_QUERY)
    queue.request_cancellation(second.id)
    assert queue.get(job.id) is None
    assert queue.get(second.id) is not None


def test_queued_cancel_is_terminal_and_request_during_execution_is_cooperative():
    queue = RadioJobScheduler()
    first = queue.submit(RadioJobKind.RADIO_SETTINGS)
    cancelled = queue.request_cancellation(first.id)
    assert cancelled.state == RadioJobState.CANCELLED
    assert queue.take_next() is None
    second = queue.submit(RadioJobKind.RADIO_QUERY)
    queue.take_next()
    current = queue.request_cancellation(second.id)
    assert current.state == RadioJobState.EXECUTING
    assert current.cancellation_requested is True
    assert current.version == 3
    # It cannot silently kill a command or pretend to retract its transmission.
    queue.transition(second.id, RadioJobState.AWAITING_RESPONSE)
    stopped = queue.request_cancellation(second.id)
    assert stopped.state == RadioJobState.CANCELLED
    assert stopped.result == RadioJobResult.STOPPED_WAITING


def test_generation_fencing_and_shutdown():
    queue = RadioJobScheduler()
    active = queue.submit(RadioJobKind.DIRECT_MESSAGE)
    queue.take_next()
    pending = queue.submit(RadioJobKind.RADIO_QUERY)
    queue.change_generation(1)
    assert queue.get(active.id).state == RadioJobState.UNKNOWN
    assert queue.get(pending.id).state == RadioJobState.FAILED
    assert queue.get(pending.id).result == RadioJobResult.RADIO_CHANGED
    with pytest.raises(InvalidJobTransition):
        queue.transition(active.id, RadioJobState.COMPLETED)
    queue.shutdown()
    with pytest.raises(RadioQueueUnavailableError):
        queue.submit(RadioJobKind.RADIO_SETTINGS)
    with pytest.raises(ValueError):
        queue.change_generation(0)


class FakeRadioRuntime:
    def __init__(self):
        self.is_connected = True
        self.is_setup_in_progress = False
        self.radio_generation = 0
        self.lock = asyncio.Lock()
        self.concurrent = 0
        self.peak = 0
        self.radio = object()

    @asynccontextmanager
    async def radio_operation(self, operation_name):
        async with self.lock:
            self.concurrent += 1
            self.peak = max(self.peak, self.concurrent)
            try:
                yield self.radio
            finally:
                self.concurrent -= 1


async def _until(predicate, timeout=1):
    async def waiter():
        while not predicate():
            await asyncio.sleep(0.001)

    await asyncio.wait_for(waiter(), timeout=timeout)


@pytest.mark.asyncio
async def test_single_worker_fifo_with_many_concurrent_submissions():
    runtime = FakeRadioRuntime()
    queue = RadioJobScheduler()
    worker = RadioJobWorker(queue, runtime=runtime, poll_interval_seconds=0.005)
    worker.start()
    worker.start()
    seen = []

    async def send(_mc, index):
        seen.append(index)
        await asyncio.sleep(0.002)
        return RadioCommandOutcome.FINISHED

    try:
        jobs = await asyncio.gather(
            *[
                asyncio.to_thread(
                    # Submit on event loop in actual producers; this stress test
                    # uses asyncio callbacks instead of concurrent OS threads.
                    lambda: None,
                )
                for _ in range(0)
            ]
        )
        assert jobs == []
        admitted = [
            worker.submit(RadioJobKind.RADIO_QUERY, lambda mc, i=i: send(mc, i)) for i in range(20)
        ]
        await _until(
            lambda: all(queue.get(j.id).state == RadioJobState.COMPLETED for j in admitted)
        )
        assert runtime.peak == 1
        assert seen == list(range(20))
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_queued_cancel_never_dispatches_and_waiting_does_not_block_commands():
    runtime = FakeRadioRuntime()
    queue = RadioJobScheduler()
    worker = RadioJobWorker(queue, runtime=runtime, poll_interval_seconds=0.005)
    worker.start()
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def first(_mc):
        entered.set()
        await release.wait()
        calls.append("first")
        return RadioCommandOutcome.AWAITING_ACK

    async def second(_mc):
        calls.append("second")
        return RadioCommandOutcome.FINISHED

    try:
        j1 = worker.submit(RadioJobKind.DIRECT_MESSAGE, first)
        await entered.wait()
        j2 = worker.submit(RadioJobKind.RADIO_QUERY, second)
        cancelled = worker.cancel(j2.id)
        assert cancelled.state == RadioJobState.CANCELLED
        release.set()
        await _until(lambda: queue.get(j1.id).state == RadioJobState.AWAITING_ACK)
        j3 = worker.submit(RadioJobKind.RADIO_QUERY, second)
        await _until(lambda: queue.get(j3.id).state == RadioJobState.COMPLETED)
        assert calls == ["first", "second"]
        assert queue.get(j1.id).state == RadioJobState.AWAITING_ACK
        worker.cancel(j1.id)
        assert queue.get(j1.id).result == RadioJobResult.STOPPED_WAITING
    finally:
        release.set()
        await worker.stop()


@pytest.mark.asyncio
async def test_worker_timeout_unknown_and_failure_is_not_retried():
    runtime = FakeRadioRuntime()
    queue = RadioJobScheduler()
    worker = RadioJobWorker(
        queue, runtime=runtime, poll_interval_seconds=0.005, cancellation_grace_seconds=0.02
    )
    worker.start()
    calls = 0

    async def uncertain(_mc):
        nonlocal calls
        calls += 1
        await asyncio.sleep(20)
        return RadioCommandOutcome.FINISHED

    try:
        job = worker.submit(RadioJobKind.DIRECT_MESSAGE, uncertain, command_timeout_seconds=0.01)
        await _until(lambda: queue.get(job.id).state == RadioJobState.UNKNOWN)
        assert queue.get(job.id).result == RadioJobResult.COMMAND_TIMEOUT
        assert calls == 1
        assert worker.quarantined  # further commands require recovery/restart
        with pytest.raises(RadioQueueUnavailableError):
            worker.submit(RadioJobKind.RADIO_QUERY, uncertain)
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_worker_fences_old_completion_after_reconnect():
    runtime = FakeRadioRuntime()
    queue = RadioJobScheduler()
    worker = RadioJobWorker(queue, runtime=runtime, poll_interval_seconds=0.005)
    worker.start()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def command(_mc):
        entered.set()
        await release.wait()
        return RadioCommandOutcome.FINISHED

    try:
        job = worker.submit(RadioJobKind.RADIO_QUERY, command)
        await entered.wait()
        queued = worker.submit(RadioJobKind.RADIO_QUERY, command)
        runtime.radio_generation += 1
        release.set()
        await _until(lambda: queue.get(job.id).state == RadioJobState.UNKNOWN)
        await _until(lambda: queue.get(queued.id).state == RadioJobState.FAILED)
        assert queue.get(job.id).result == RadioJobResult.RADIO_CHANGED
        assert queue.get(queued.id).result == RadioJobResult.RADIO_CHANGED
    finally:
        release.set()
        await worker.stop()


@pytest.mark.asyncio
async def test_worker_does_not_claim_delivery_or_log_exception_secrets(caplog):
    runtime = FakeRadioRuntime()
    queue = RadioJobScheduler()
    worker = RadioJobWorker(queue, runtime=runtime, poll_interval_seconds=0.005)
    worker.start()

    async def local_send(_mc):
        return RadioCommandOutcome.FINISHED

    async def error(_mc):
        raise RuntimeError("secret-password-in-device-error")

    try:
        sent = worker.submit(RadioJobKind.DIRECT_MESSAGE, local_send)
        failed = worker.submit(RadioJobKind.RADIO_QUERY, error)
        await _until(lambda: queue.get(sent.id).state == RadioJobState.UNKNOWN)
        await _until(lambda: queue.get(failed.id).state == RadioJobState.UNKNOWN)
        assert queue.get(sent.id).result == RadioJobResult.TRANSMISSION_UNCERTAIN
        assert "secret-password-in-device-error" not in caplog.text
    finally:
        await worker.stop()


def test_process_lease_refuses_duplicate_owner(tmp_path: Path):
    path = tmp_path / "radio.lock"
    owner = RadioProcessLease(path)
    duplicate = RadioProcessLease(path)
    owner.acquire()
    try:
        with pytest.raises(RuntimeError, match="one worker"):
            duplicate.acquire()
    finally:
        owner.release()
    duplicate.acquire()
    duplicate.release()


@pytest.mark.asyncio
async def test_cannot_start_second_worker_for_same_radio_queue():
    queue = RadioJobScheduler()
    first = RadioJobWorker(queue, runtime=FakeRadioRuntime())
    second = RadioJobWorker(queue, runtime=FakeRadioRuntime())
    first.start()
    try:
        with pytest.raises(RadioQueueUnavailableError, match="Only one"):
            second.start()
    finally:
        await first.stop()
    second.start()
    await second.stop()


@pytest.mark.asyncio
async def test_unexpected_radio_disconnect_fences_pending_work_even_without_reconnect():
    runtime = FakeRadioRuntime()
    queue = RadioJobScheduler()
    worker = RadioJobWorker(queue, runtime=runtime, poll_interval_seconds=0.005)
    worker.start()
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def command(_mc):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return RadioCommandOutcome.FINISHED

    try:
        running = worker.submit(RadioJobKind.RADIO_QUERY, command)
        await entered.wait()
        pending = worker.submit(RadioJobKind.RADIO_QUERY, command)
        runtime.is_connected = False  # real physical link may drop before monitor notices
        release.set()
        await _until(lambda: queue.get(pending.id).state == RadioJobState.FAILED)
        assert queue.get(running.id).state == RadioJobState.UNKNOWN
        assert calls == 1
        with pytest.raises(RadioQueueUnavailableError):
            worker.submit(RadioJobKind.RADIO_QUERY, command)
    finally:
        release.set()
        await worker.stop()


@pytest.mark.asyncio
async def test_uncooperative_command_is_quarantined_without_hanging_shutdown():
    runtime = FakeRadioRuntime()
    queue = RadioJobScheduler()
    worker = RadioJobWorker(
        queue, runtime=runtime, poll_interval_seconds=0.005, cancellation_grace_seconds=0.02
    )
    block = asyncio.Event()
    worker.start()

    async def stubborn(_mc):
        try:
            await block.wait()
        except asyncio.CancelledError:
            await block.wait()  # library ignored cooperative task cancellation
        return RadioCommandOutcome.FINISHED

    job = worker.submit(RadioJobKind.DIRECT_MESSAGE, stubborn, command_timeout_seconds=0.01)
    try:
        await _until(lambda: worker.quarantined)
        assert queue.get(job.id).state == RadioJobState.UNKNOWN
        assert queue.get(job.id).result == RadioJobResult.COMMAND_TIMEOUT
        await asyncio.wait_for(worker.stop(), timeout=0.2)
        with pytest.raises(RadioQueueUnavailableError):
            worker.start()
    finally:
        block.set()
        await asyncio.sleep(0)


def test_direct_transition_cannot_steal_command_permit():
    queue = RadioJobScheduler()
    a = queue.submit(RadioJobKind.RADIO_QUERY)
    b = queue.submit(RadioJobKind.RADIO_SETTINGS)
    queue.take_next()
    with pytest.raises(InvalidJobTransition, match="permit"):
        queue.transition(b.id, RadioJobState.EXECUTING)
    queue.transition(a.id, RadioJobState.AWAITING_RESPONSE)
    assert queue.take_next().id == b.id
