"""Hardware-free release-gate checks for the migrated radio command boundary."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.radio import RadioOperationBusyError
from app.services import radio_producers
from app.services.radio_job_scheduler import RadioJobScheduler
from app.services.radio_job_worker import RadioCommandOutcome, RadioJobWorker
from app.services.radio_jobs import RadioJobKind, RadioJobState


class Transport:
    def __init__(self):
        self.is_connected = True
        self.is_setup_in_progress = False
        self.radio_generation = 0
        self.lock = asyncio.Lock()
        self.reset_channel_send_cache = lambda: None
        self.clear_pending_message_channel_slots = lambda: None

    @asynccontextmanager
    async def raw_radio_operation(self, _name, **_kwargs):
        async with self.lock:
            yield self


async def _wait_until(predicate, timeout=1.5):
    async def check():
        while not predicate():
            await asyncio.sleep(0.002)

    await asyncio.wait_for(check(), timeout)


@pytest.mark.asyncio
async def test_deferred_background_coalesces_and_ages_ahead_of_new_high(monkeypatch):
    runtime = Transport()
    scheduler = RadioJobScheduler(aging_seconds=0.02)
    worker = RadioJobWorker(scheduler, runtime=runtime, poll_interval_seconds=0.002)
    monkeypatch.setattr(radio_producers, "radio_job_worker", worker)
    monkeypatch.setattr(radio_producers, "radio_job_scheduler", scheduler)
    worker.start()
    entered = asyncio.Event()
    release = asyncio.Event()
    order = []

    async def first_high():
        async with radio_producers.scheduled_radio_operation(runtime, "send_channel_message"):
            entered.set()
            await release.wait()
            order.append("high-1")

    async def periodic():
        async with radio_producers.scheduled_radio_operation(
            runtime, "periodic_advertisement", blocking=False, defer_when_busy=True
        ):
            order.append("low")

    async def second_high():
        async with radio_producers.scheduled_radio_operation(runtime, "send_direct_message"):
            order.append("high-2")

    high = asyncio.create_task(first_high())
    low = None
    later = None
    try:
        await asyncio.wait_for(entered.wait(), 1)
        low = asyncio.create_task(periodic())
        await _wait_until(lambda: scheduler.queue_size == 1)
        with pytest.raises(RadioOperationBusyError):
            async with radio_producers.scheduled_radio_operation(
                runtime, "periodic_advertisement", blocking=False, defer_when_busy=True
            ):
                pytest.fail("A second background operation must not share a command closure")
        later = asyncio.create_task(second_high())
        await _wait_until(lambda: scheduler.queue_size == 2)
        await asyncio.sleep(0.07)
        release.set()
        await asyncio.gather(high, low, later)
        assert order == ["high-1", "low", "high-2"]
        assert scheduler.queue_size == 0
    finally:
        release.set()
        for task in (high, low, later):
            if task is not None and not task.done():
                task.cancel()
        await worker.stop()


@pytest.mark.asyncio
async def test_reboot_barrier_fences_next_queued_command_before_dispatch(monkeypatch):
    runtime = Transport()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=runtime, poll_interval_seconds=0.002)
    monkeypatch.setattr(radio_producers, "radio_job_worker", worker)
    monkeypatch.setattr(radio_producers, "radio_job_scheduler", scheduler)
    worker.start()
    entered = asyncio.Event()
    release = asyncio.Event()
    other_ran = False

    async def reboot():
        async with radio_producers.scheduled_radio_operation(runtime, "reboot_radio"):
            entered.set()
            await release.wait()

    async def next_command():
        nonlocal other_ran
        async with radio_producers.scheduled_radio_operation(runtime, "send_direct_message"):
            other_ran = True

    first = asyncio.create_task(reboot())
    other = None
    try:
        await asyncio.wait_for(entered.wait(), 1)
        other = asyncio.create_task(next_command())
        await _wait_until(lambda: scheduler.queue_size == 1)
        release.set()
        results = await asyncio.gather(first, other, return_exceptions=True)
        assert not other_ran
        assert runtime.radio_generation == 1
        assert isinstance(results[1], Exception)
        queued = [job for job in scheduler.list_jobs() if job.kind == RadioJobKind.DIRECT_MESSAGE]
        assert len(queued) == 1
        assert queued[0].state == RadioJobState.FAILED
    finally:
        release.set()
        if other is not None and not other.done():
            other.cancel()
        await worker.stop()


@pytest.mark.asyncio
async def test_typed_202_manual_advertisement_is_idempotent_and_not_generic(client, monkeypatch):
    from app.routers import radio_jobs

    scheduler = RadioJobScheduler()
    calls = []

    def submit(kind, callback, **options):
        calls.append(callback)
        return scheduler.submit(kind, **options)

    monkeypatch.setattr(radio_jobs, "radio_job_worker", SimpleNamespace(submit=submit))
    monkeypatch.setattr(
        radio_jobs, "radio_runtime", SimpleNamespace(require_connected=lambda: None)
    )
    mock_advert = AsyncMock(return_value=True)
    monkeypatch.setattr(radio_jobs, "send_advertisement", mock_advert)
    headers = {"Idempotency-Key": "request-abc-123"}

    first = await client.post(
        "/api/radio/jobs/advertise", json={"mode": "zero_hop"}, headers=headers
    )
    assert first.status_code == 202, first.text
    second = await client.post(
        "/api/radio/jobs/advertise", json={"mode": "zero_hop"}, headers=headers
    )
    assert second.status_code == 202
    assert first.json() == second.json()
    assert len(calls) == 2  # only the first callback is stored by the real worker
    assert len(scheduler.list_jobs()) == 1
    assert (
        await client.post("/api/radio/jobs/advertise", json={"mode": "flood"}, headers=headers)
    ).status_code == 409
    assert (
        await client.post("/api/radio/jobs/advertise", json={"mode": "invalid"}, headers=headers)
    ).status_code == 422
    assert (
        await client.post("/api/radio/jobs/advertise", json={"mode": "flood"})
    ).status_code == 422
    assert (await client.post("/api/radio/jobs", json={"command": "anything"})).status_code == 405
    outcome = await calls[0](object())
    assert outcome == RadioCommandOutcome.FINISHED
    mock_advert.assert_awaited_once_with(
        mock_advert.await_args.args[0], force=True, mode="zero_hop"
    )


@pytest.mark.asyncio
async def test_worker_nested_domain_operation_reuses_only_owner_permit():
    """An async domain service must not recursively enqueue or take another lock."""
    runtime = Transport()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=runtime)
    snapshot = scheduler.submit(RadioJobKind.DIRECT_MESSAGE)
    seen = []

    # Calling a nested service is allowed only from the worker's owner task.
    async def wrapped(mc):
        async with radio_producers.scheduled_radio_operation(runtime, "send_direct_message"):
            seen.append("worker")
        return RadioCommandOutcome.UNCERTAIN

    # The worker automatically installs the scoped transport for its callback.
    result = await worker._execute(snapshot, wrapped, {})
    assert result == RadioCommandOutcome.UNCERTAIN
    assert seen == ["worker"]
    assert scheduler.queue_size == 1


@pytest.mark.asyncio
async def test_async_message_endpoints_validate_and_fingerprint_requests(client, monkeypatch):
    from app.routers import radio_jobs

    scheduler = RadioJobScheduler()
    callbacks = []

    def submit(kind, callback, **options):
        callbacks.append(callback)
        return scheduler.submit(kind, **options)

    monkeypatch.setattr(radio_jobs, "radio_job_worker", SimpleNamespace(submit=submit))
    monkeypatch.setattr(
        radio_jobs, "radio_runtime", SimpleNamespace(require_connected=lambda: None)
    )
    contact = SimpleNamespace(public_key="a" * 64)
    channel = SimpleNamespace(name="Test")
    monkeypatch.setattr(
        radio_jobs,
        "ContactRepository",
        SimpleNamespace(get_by_key_or_prefix=AsyncMock(return_value=contact)),
    )
    monkeypatch.setattr(
        radio_jobs,
        "ChannelRepository",
        SimpleNamespace(get_by_key=AsyncMock(return_value=channel)),
    )
    header = {"Idempotency-Key": "unique-dm-0001"}
    dm_body = {"destination": "a" * 64, "text": "hello"}

    first = await client.post("/api/radio/jobs/send/direct", json=dm_body, headers=header)
    assert first.status_code == 202, first.text
    repeated = await client.post("/api/radio/jobs/send/direct", json=dm_body, headers=header)
    assert repeated.json() == first.json()
    assert len(scheduler.list_jobs()) == 1
    conflict = await client.post(
        "/api/radio/jobs/send/direct",
        json={**dm_body, "text": "another"},
        headers=header,
    )
    assert conflict.status_code == 409
    assert (await client.post("/api/radio/jobs/send/direct", json=dm_body)).status_code == 422
    assert (
        await client.post(
            "/api/radio/jobs/send/channel",
            json={"channel_key": "abc", "text": "hello"},
            headers=header,
        )
    ).status_code == 400

    channel_body = {"channel_key": "bb" * 16, "text": "hello"}
    accepted = await client.post(
        "/api/radio/jobs/send/channel",
        json=channel_body,
        headers={"Idempotency-Key": "unique-channel-0001"},
    )
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["state"] == "queued"
    assert len(scheduler.list_jobs()) == 2
    assert len(callbacks) == 4  # submitted closures are discarded on duplicate/conflict
    for job in scheduler.list_jobs():
        assert "hello" not in job.model_dump_json()
        assert "a" * 64 not in job.model_dump_json()


def test_no_producer_imports_raw_global_radio_manager():
    """All non-lifecycle producers must use the process-owned runtime seam."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "app"
    for source in root.rglob("*.py"):
        if source.name in {"radio.py", "radio_runtime.py"}:
            continue
        content = source.read_text()
        assert "from app.radio import radio_manager" not in content, source
        assert "app.radio.radio_manager" not in content, source
