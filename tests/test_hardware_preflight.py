"""No-hardware regression tests for the first MeshCore companion smoke run."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from meshcore import EventType

import app.config as config
import app.routers.server_control as server_control
import app.services.radio_job_worker as worker_module
import app.services.radio_response_tracker as tracker_module
from app.models import Contact
from app.services.radio_job_scheduler import RadioJobScheduler
from app.services.radio_job_worker import RadioCommandOutcome, RadioJobWorker
from app.services.radio_jobs import RadioJobKind, RadioJobPriority, RadioJobState
from app.services.radio_lifecycle import run_post_connect_setup
from app.services.radio_response_tracker import RadioResponseTracker


@pytest.mark.asyncio
async def test_passive_startup_only_queries_device_and_receives(monkeypatch):
    """The startup flag must NOT merely skip background offload/advertisement."""
    monkeypatch.setattr(config.settings, "passive_startup", True)
    monkeypatch.setattr(config.settings, "skip_post_connect_sync", False)
    mc = MagicMock()
    mc.commands.send_device_query = AsyncMock(return_value=SimpleNamespace(payload={"fw ver": 10}))
    mc.commands.get_time = AsyncMock(return_value=SimpleNamespace(payload={"time": 1000}))
    mc.commands.set_time = AsyncMock()
    mc.commands.reboot = AsyncMock()
    mc.commands.set_flood_scope = AsyncMock()
    mc._reader.handle_rx = AsyncMock()
    mc.start_auto_message_fetching = AsyncMock()
    manager = MagicMock()
    manager.meshcore = mc
    manager._setup_lock = None
    manager._acquire_operation_lock = AsyncMock()
    manager._release_operation_lock = MagicMock()

    with (
        patch("app.event_handlers.register_event_handlers") as register,
        patch("app.keystore.export_and_store_private_key", new_callable=AsyncMock) as export,
        patch("app.radio_sync.sync_radio_time", new_callable=AsyncMock) as time_sync,
        patch("app.repository.AppSettingsRepository.get", new_callable=AsyncMock) as settings_get,
        patch("app.services.flood_scope.set_radio_flood_scope", new_callable=AsyncMock) as scope,
        patch("app.radio_sync.sync_and_offload_all", new_callable=AsyncMock) as offload,
        patch("app.radio_sync.send_advertisement", new_callable=AsyncMock) as advert,
        patch("app.radio_sync.drain_pending_messages", new_callable=AsyncMock) as drain,
        patch("app.radio_sync.start_periodic_sync") as sync_loop,
        patch("app.radio_sync.start_periodic_advert") as advert_loop,
        patch("app.radio_sync.start_message_polling") as poll_loop,
        patch("app.radio_sync.start_telemetry_collect") as telemetry_loop,
    ):
        await run_post_connect_setup(manager)
    register.assert_called_once_with(mc)
    mc.commands.send_device_query.assert_awaited_once()
    mc.start_auto_message_fetching.assert_awaited_once()
    for call in (export, time_sync, settings_get, scope, offload, advert, drain):
        call.assert_not_awaited()
    for call in (sync_loop, advert_loop, poll_loop, telemetry_loop):
        call.assert_not_called()
    mc.commands.set_time.assert_not_awaited()
    mc.commands.reboot.assert_not_awaited()
    mc.commands.set_flood_scope.assert_not_awaited()


class FakeRuntime:
    def __init__(self, mc):
        self.meshcore = mc
        self.is_connected = True
        self.is_setup_in_progress = False
        self.radio_generation = 0
        self.lock = asyncio.Lock()

    @asynccontextmanager
    async def raw_radio_operation(self, name, **kwargs):
        async with self.lock:
            yield self.meshcore


class FakeEvents:
    def __init__(self):
        self.listeners = []
        self.commands = MagicMock()
        self.commands.send_login = AsyncMock(return_value=SimpleNamespace(type=EventType.MSG_SENT))
        self.commands.reset_path = AsyncMock(return_value=SimpleNamespace(type=EventType.OK))

    def subscribe(self, event_type, callback, attribute_filters=None):
        entry = [event_type, callback, attribute_filters, True]
        self.listeners.append(entry)

        def unsubscribe():
            entry[3] = False

        return SimpleNamespace(unsubscribe=unsubscribe)

    def login_success(self, target):
        for event_type, callback, filters, active in list(self.listeners):
            if (
                active
                and event_type == EventType.LOGIN_SUCCESS
                and filters == {"pubkey_prefix": target}
            ):
                callback(SimpleNamespace(payload={"pubkey_prefix": target}))


async def until(condition, timeout=2):
    async def poll():
        while not condition():
            await asyncio.sleep(0.002)

    await asyncio.wait_for(poll(), timeout)


@pytest.mark.asyncio
async def test_late_login_confirmation_cancels_queued_flood_retry(monkeypatch):
    mc = FakeEvents()
    runtime = FakeRuntime(mc)
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=runtime, poll_interval_seconds=0.002)
    tracker = RadioResponseTracker(scheduler)
    monkeypatch.setattr(worker_module, "radio_job_worker", worker)
    monkeypatch.setattr(worker_module, "radio_job_scheduler", scheduler)
    monkeypatch.setattr(tracker_module, "radio_response_tracker", tracker)
    monkeypatch.setattr(server_control, "radio_manager", runtime)
    monkeypatch.setattr(server_control, "_ensure_on_radio", AsyncMock())
    contact = Contact(
        public_key="ab" * 32,
        name="Fixture",
        type=2,
        direct_path="cd",
        direct_path_len=1,
        direct_path_hash_mode=0,
    )
    held = asyncio.Event()
    release = asyncio.Event()

    async def blocker(_mc):
        held.set()
        await release.wait()
        return RadioCommandOutcome.FINISHED

    worker.start()
    task = asyncio.create_task(
        server_control.scheduled_authenticated_contact_login(
            contact, "only-in-fake", label="repeater", response_timeout=0.02
        )
    )
    try:
        await until(lambda: mc.commands.send_login.await_count == 1)
        await until(
            lambda: any(
                job.state == RadioJobState.AWAITING_RESPONSE for job in scheduler.list_jobs()
            )
        )
        # Force the retry to remain queued while an unrelated high-priority
        # command is using the only radio permit.
        worker.submit(
            RadioJobKind.RADIO_QUERY,
            blocker,
            priority=RadioJobPriority.HIGH,
            command_timeout_seconds=5,
        )
        await asyncio.wait_for(held.wait(), 1)
        await until(lambda: scheduler.queue_size == 1)
        mc.login_success(contact.public_key[:12])
        response = await asyncio.wait_for(task, 2)
        assert response.status == "ok"
        assert response.authenticated is True
        retry = [j for j in scheduler.list_jobs() if j.kind == RadioJobKind.REPEATER_LOGIN][1]
        assert retry.state == RadioJobState.CANCELLED
        assert mc.commands.send_login.await_count == 1
        mc.commands.reset_path.assert_not_awaited()
    finally:
        release.set()
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await worker.stop()
        tracker.shutdown()


@pytest.mark.asyncio
async def test_cancelling_login_http_request_drops_unstarted_retry(monkeypatch):
    mc = FakeEvents()
    runtime = FakeRuntime(mc)
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=runtime, poll_interval_seconds=0.002)
    tracker = RadioResponseTracker(scheduler)
    monkeypatch.setattr(worker_module, "radio_job_worker", worker)
    monkeypatch.setattr(worker_module, "radio_job_scheduler", scheduler)
    monkeypatch.setattr(tracker_module, "radio_response_tracker", tracker)
    monkeypatch.setattr(server_control, "radio_manager", runtime)
    monkeypatch.setattr(server_control, "_ensure_on_radio", AsyncMock())
    contact = Contact(
        public_key="ab" * 32,
        name="Fixture",
        type=2,
        direct_path="cd",
        direct_path_len=1,
        direct_path_hash_mode=0,
    )
    held = asyncio.Event()
    release = asyncio.Event()

    async def blocker(_mc):
        held.set()
        await release.wait()
        return RadioCommandOutcome.FINISHED

    worker.start()
    task = asyncio.create_task(
        server_control.scheduled_authenticated_contact_login(
            contact, "only-in-fake", label="repeater", response_timeout=0.02
        )
    )
    try:
        await until(lambda: mc.commands.send_login.await_count == 1)
        await until(
            lambda: any(
                job.state == RadioJobState.AWAITING_RESPONSE for job in scheduler.list_jobs()
            )
        )
        worker.submit(
            RadioJobKind.RADIO_QUERY,
            blocker,
            priority=RadioJobPriority.HIGH,
            command_timeout_seconds=5,
        )
        await asyncio.wait_for(held.wait(), 1)
        await until(lambda: scheduler.queue_size == 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        retries = [j for j in scheduler.list_jobs() if j.kind == RadioJobKind.REPEATER_LOGIN]
        assert len(retries) == 2
        assert retries[1].state == RadioJobState.CANCELLED
        assert mc.commands.send_login.await_count == 1
    finally:
        release.set()
        await worker.stop()
        tracker.shutdown()


@pytest.mark.asyncio
async def test_flood_reply_deadline_starts_only_after_retry_command(monkeypatch):
    """A busy command slot must not consume the RF reply timeout for flood."""
    mc = FakeEvents()
    runtime = FakeRuntime(mc)
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=runtime, poll_interval_seconds=0.002)
    tracker = RadioResponseTracker(scheduler)
    monkeypatch.setattr(worker_module, "radio_job_worker", worker)
    monkeypatch.setattr(worker_module, "radio_job_scheduler", scheduler)
    monkeypatch.setattr(tracker_module, "radio_response_tracker", tracker)
    monkeypatch.setattr(server_control, "radio_manager", runtime)
    monkeypatch.setattr(server_control, "_ensure_on_radio", AsyncMock())
    contact = Contact(
        public_key="ab" * 32,
        name="Fixture",
        type=2,
        direct_path="cd",
        direct_path_len=1,
        direct_path_hash_mode=0,
    )
    held = asyncio.Event()
    release = asyncio.Event()

    async def blocker(_mc):
        held.set()
        await release.wait()
        return RadioCommandOutcome.FINISHED

    async def send_login(*_args):
        if mc.commands.send_login.await_count == 2:
            mc.login_success(contact.public_key[:12])
        return SimpleNamespace(type=EventType.MSG_SENT)

    mc.commands.send_login.side_effect = send_login
    worker.start()
    task = asyncio.create_task(
        server_control.scheduled_authenticated_contact_login(
            contact, "only-in-fake", label="repeater", response_timeout=0.02
        )
    )
    try:
        await until(lambda: mc.commands.send_login.await_count == 1)
        await until(
            lambda: any(
                job.state == RadioJobState.AWAITING_RESPONSE for job in scheduler.list_jobs()
            )
        )
        worker.submit(
            RadioJobKind.RADIO_QUERY,
            blocker,
            priority=RadioJobPriority.HIGH,
            command_timeout_seconds=5,
        )
        await asyncio.wait_for(held.wait(), 1)
        await until(lambda: scheduler.queue_size == 1)
        await asyncio.sleep(0.09)  # > four RF response timeout windows
        assert not task.done(), "Response deadline must not expire while retry is queued"
        release.set()
        response = await asyncio.wait_for(task, 2)
        assert response.status == "ok"
        assert mc.commands.send_login.await_count == 2
    finally:
        release.set()
        if not task.done():
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        await worker.stop()
        tracker.shutdown()
