"""Worker-backed legacy producer migration: no real RF hardware required."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from meshcore import EventType

import app.services.radio_producers as producers
from app.radio import RadioOperationBusyError
from app.routers.radio import RadioConfigUpdate
from app.services.radio_commands import (
    PathHashModeUnsupportedError,
    apply_radio_config_transaction,
)
from app.services.radio_job_scheduler import RadioJobScheduler
from app.services.radio_job_worker import RadioJobWorker
from app.services.radio_jobs import RadioJobKind, RadioJobPriority, RadioJobState


class FakeRuntime:
    def __init__(self):
        self.is_connected = True
        self.is_setup_in_progress = False
        self.radio_generation = 0
        self.active = 0
        self.peak = 0
        self.calls = []
        self.lock = asyncio.Lock()

    @asynccontextmanager
    async def raw_radio_operation(self, name, **kwargs):
        async with self.lock:
            self.active += 1
            self.peak = max(self.active, self.peak)
            self.calls.append((name, kwargs))
            try:
                yield getattr(self, "meshcore", self)
            finally:
                self.active -= 1


@pytest.mark.asyncio
async def test_producers_share_one_worker_command_slot(monkeypatch):
    rt = FakeRuntime()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=rt, poll_interval_seconds=0.005)
    monkeypatch.setattr(producers, "radio_job_worker", worker)
    monkeypatch.setattr(producers, "radio_job_scheduler", scheduler)
    worker.start()
    visited = []

    async def producer(name):
        async def command(_mc):
            visited.append(f"{name}:enter")
            await asyncio.sleep(0.01)
            visited.append(f"{name}:exit")

        await producers.run_scheduled_radio_command(rt, name, command, pause_polling=True)

    try:
        await asyncio.gather(
            producer("send_direct_message"),
            producer("send_channel_message"),
            producer("repeater_status"),
        )
        assert rt.peak == 1
        assert visited == [
            "send_direct_message:enter",
            "send_direct_message:exit",
            "send_channel_message:enter",
            "send_channel_message:exit",
            "repeater_status:enter",
            "repeater_status:exit",
        ]
        assert len(scheduler.list_jobs()) == 3
        assert all(options == {"pause_polling": True} for _, options in rt.calls)
        assert all(job.correlation_scope for job in scheduler.list_jobs())
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_command_callback_executes_in_worker_task_and_returns_result(monkeypatch):
    rt = FakeRuntime()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=rt, poll_interval_seconds=0.005)
    monkeypatch.setattr(producers, "radio_job_worker", worker)
    monkeypatch.setattr(producers, "radio_job_scheduler", scheduler)
    caller = asyncio.current_task()
    callback_task = None

    async def command(mc):
        nonlocal callback_task
        callback_task = asyncio.current_task()
        assert mc is rt
        return {"value": 42}

    worker.start()
    try:
        result = await producers.run_scheduled_radio_command(rt, "radio_query", command)
        assert result == {"value": 42}
        assert callback_task is not caller
        assert callback_task is not None
        assert callback_task.get_name() == "radio-job-command"
        assert scheduler.list_jobs()[0].state == RadioJobState.COMPLETED
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_worker_executed_callback_is_bounded_by_command_deadline(monkeypatch):
    rt = FakeRuntime()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(
        scheduler,
        runtime=rt,
        cancellation_grace_seconds=0.05,
        poll_interval_seconds=0.001,
    )
    monkeypatch.setattr(producers, "radio_job_worker", worker)
    monkeypatch.setattr(producers, "radio_job_scheduler", scheduler)
    monkeypatch.setattr(producers, "command_timeout_for_operation", lambda _name: 0.01)
    cancelled = asyncio.Event()

    async def command(_mc):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    worker.start()
    try:
        with pytest.raises(Exception) as exc:
            await producers.run_scheduled_radio_command(rt, "radio_query", command)
        assert getattr(exc.value, "status_code", None) == 504
        assert cancelled.is_set()
        assert scheduler.list_jobs()[0].state == RadioJobState.UNKNOWN
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_low_priority_periodic_work_skips_busy_command(monkeypatch):
    rt = FakeRuntime()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=rt, poll_interval_seconds=0.005)
    monkeypatch.setattr(producers, "radio_job_worker", worker)
    monkeypatch.setattr(producers, "radio_job_scheduler", scheduler)
    worker.start()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def active():
        async def command(_mc):
            entered.set()
            await release.wait()

        await producers.run_scheduled_radio_command(rt, "send_channel_message", command)

    task = asyncio.create_task(active())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        with pytest.raises(RadioOperationBusyError):
            await producers.run_scheduled_radio_command(
                rt,
                "periodic_advertisement",
                AsyncMock(),
                blocking=False,
            )
        assert scheduler.queue_size == 0
        assert producers.classify_operation("periodic_advertisement") == (
            RadioJobKind.PERIODIC_ADVERTISEMENT,
            RadioJobPriority.LOW,
        )
    finally:
        release.set()
        await task
        await worker.stop()


@pytest.mark.asyncio
async def test_aborted_producer_marks_result_uncertain_and_releases_lock(monkeypatch):
    rt = FakeRuntime()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=rt, poll_interval_seconds=0.005)
    monkeypatch.setattr(producers, "radio_job_worker", worker)
    monkeypatch.setattr(producers, "radio_job_scheduler", scheduler)
    worker.start()
    try:

        async def fail(_mc):
            raise ValueError("producer failed")

        with pytest.raises(ValueError, match="producer failed"):
            await producers.run_scheduled_radio_command(rt, "send_direct_message", fail)

        async def settled():
            while any(job.state == RadioJobState.EXECUTING for job in scheduler.list_jobs()):
                await asyncio.sleep(0.001)

        await asyncio.wait_for(settled(), 1)
        assert rt.active == 0
        assert scheduler.list_jobs()[0].state == RadioJobState.UNKNOWN
    finally:
        await worker.stop()


def _result(event_type=EventType.OK):
    return MagicMock(type=event_type, payload={})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected_reason"),
    [
        ("queue_full", "queue_full"),
        ("transport_unavailable", "transport_unavailable"),
        ("radio_busy", "radio_busy"),
        ("target_busy", "target_busy"),
    ],
)
async def test_login_admission_returns_structured_blocker_reason(
    monkeypatch, error, expected_reason
):
    import app.routers.server_control as server_control
    import app.services.radio_job_worker as worker_module
    import app.services.radio_response_tracker as tracker_module
    from app.models import CONTACT_TYPE_REPEATER
    from app.services.radio_job_scheduler import (
        RadioAdmissionError,
        RadioQueueFullError,
        RadioQueueUnavailableError,
    )
    from app.services.radio_response_tracker import ResponseReservationConflict

    worker = MagicMock()
    tracker = MagicMock()
    if error == "queue_full":
        worker.submit.side_effect = RadioQueueFullError("full")
    elif error == "transport_unavailable":
        worker.submit.side_effect = RadioQueueUnavailableError("stopped")
    elif error == "radio_busy":
        worker.submit.side_effect = RadioAdmissionError("busy")
    else:
        worker.submit.return_value = SimpleNamespace(id=uuid4())
        tracker.reserve.side_effect = ResponseReservationConflict(
            "Conflicting target response session"
        )

    monkeypatch.setattr(worker_module, "radio_job_worker", worker)
    monkeypatch.setattr(tracker_module, "radio_response_tracker", tracker)
    contact = SimpleNamespace(
        type=CONTACT_TYPE_REPEATER,
        public_key="ab" * 32,
        effective_route_source="flood",
    )

    response = await server_control.scheduled_authenticated_contact_login(
        contact, "private-password", label="repeater"
    )

    assert response.authenticated is False
    assert response.reason == expected_reason
    assert "private-password" not in str(response.model_dump())
    if error == "target_busy":
        worker.cancel.assert_called_once()


@pytest.mark.asyncio
async def test_config_transaction_restores_original_values_after_partial_failure():
    mc = MagicMock()
    mc.self_info = {"name": "Old", "tx_power": 12}
    mc.commands.set_name = AsyncMock(return_value=_result())
    mc.commands.set_tx_power = AsyncMock(side_effect=[RuntimeError("radio rejected"), _result()])
    mc.commands.send_appstart = AsyncMock(return_value=_result())
    with pytest.raises(RuntimeError, match="radio rejected"):
        await apply_radio_config_transaction(
            mc,
            RadioConfigUpdate(name="New", tx_power=20),
            path_hash_mode_supported=False,
            current_path_hash_mode=0,
            set_path_hash_mode=lambda _: None,
            sync_radio_time_fn=AsyncMock(),
        )
    assert mc.commands.set_name.await_args_list[0].args == ("New",)
    assert mc.commands.set_name.await_args_list[-1].args == ("Old",)
    mc.commands.set_tx_power.assert_any_await(val=12)


@pytest.mark.asyncio
async def test_config_support_checked_before_mutations():
    mc = MagicMock()
    mc.self_info = {"name": "Old"}
    mc.commands.set_name = AsyncMock()
    with pytest.raises(PathHashModeUnsupportedError):
        await apply_radio_config_transaction(
            mc,
            RadioConfigUpdate(name="New", path_hash_mode=1),
            path_hash_mode_supported=False,
            current_path_hash_mode=0,
            set_path_hash_mode=lambda _: None,
            sync_radio_time_fn=AsyncMock(),
        )
    mc.commands.set_name.assert_not_awaited()


@pytest.mark.asyncio
async def test_login_waiter_does_not_hold_worker_permit(monkeypatch):
    """A repeater login and an unrelated command overlap without two RF commands."""
    from types import SimpleNamespace

    from meshcore import EventType

    import app.routers.server_control as server_control
    import app.services.radio_job_worker as worker_module
    import app.services.radio_response_tracker as tracker_module
    from app.models import CONTACT_TYPE_REPEATER
    from app.services.radio_job_worker import RadioCommandOutcome
    from app.services.radio_response_tracker import RadioResponseTracker

    class MeshCoreMock:
        def __init__(self):
            self.subscribers = []
            self.send_started = asyncio.Event()
            self.commands = SimpleNamespace(send_login=self.send_login)

        async def send_login(self, _key, _password):
            self.send_started.set()
            return _result()

        def subscribe(self, event_type, callback, attribute_filters=None):
            record = [event_type, callback, attribute_filters, True]
            self.subscribers.append(record)
            return SimpleNamespace(unsubscribe=lambda: record.__setitem__(3, False))

        def emit(self, event_type):
            for kind, callback, _filters, active in list(self.subscribers):
                if active and kind == event_type:
                    callback(SimpleNamespace(payload={}))

    rt = FakeRuntime()
    rt.meshcore = MeshCoreMock()
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=rt, poll_interval_seconds=0.005)
    tracker = RadioResponseTracker(scheduler, generation_provider=lambda: rt.radio_generation)
    monkeypatch.setattr(worker_module, "radio_job_worker", worker)
    monkeypatch.setattr(worker_module, "radio_job_scheduler", scheduler)
    monkeypatch.setattr(tracker_module, "radio_response_tracker", tracker)
    monkeypatch.setattr(server_control, "radio_manager", rt)
    monkeypatch.setattr(server_control, "_ensure_on_radio", AsyncMock())
    worker.start()
    contact = SimpleNamespace(
        type=CONTACT_TYPE_REPEATER,
        public_key="ab" * 32,
        effective_route_source="flood",
    )
    login = asyncio.create_task(
        server_control.scheduled_authenticated_contact_login(
            contact, "private-password", label="repeater", response_timeout=1
        )
    )
    try:
        await asyncio.wait_for(rt.meshcore.send_started.wait(), 1)

        async def other_command(mc):
            return RadioCommandOutcome.FINISHED

        other = worker.submit(RadioJobKind.RADIO_QUERY, other_command)

        async def until_other_finishes():
            while scheduler.get(other.id).state != RadioJobState.COMPLETED:
                await asyncio.sleep(0.001)

        await asyncio.wait_for(until_other_finishes(), 1)
        rt.meshcore.emit(EventType.LOGIN_SUCCESS)
        reply = await asyncio.wait_for(login, 2)
        assert reply.authenticated is True
        assert reply.reason == "confirmed"
        assert rt.peak == 1
        assert any(
            j.state == RadioJobState.COMPLETED and j.kind == RadioJobKind.REPEATER_LOGIN
            for j in scheduler.list_jobs()
        )
        assert all("private-password" not in str(j.model_dump()) for j in scheduler.list_jobs())
        again = await server_control.scheduled_authenticated_contact_login(
            contact, "private-password", label="repeater", response_timeout=0.01
        )
        assert again.authenticated is False  # a real second attempt may time out
        assert again.reason == "not_confirmed"
    finally:
        if not login.done():
            login.cancel()
        await worker.stop()
        tracker.shutdown()


def test_migrated_producer_modules_do_not_import_direct_radio_manager():
    """Lifecycle code is allowed direct manager access; migrated producers are not."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    paths = [
        *list((root / "app" / "routers").glob("*.py")),
        root / "app" / "radio_sync.py",
        root / "app" / "services" / "message_send.py",
        root / "app" / "services" / "radio_stats.py",
        root / "app" / "fanout" / "community_mqtt.py",
    ]
    for path in paths:
        source = path.read_text(encoding="utf-8")
        assert "from app.radio import radio_manager" not in source, path.name
        assert "from app.radio import RadioManager" not in source, path.name


def test_legacy_radio_operation_bridge_has_a_closed_migration_allowlist():
    """New producers must execute callbacks in the worker, not borrow its lock."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    allowed = {
        "app/services/radio_runtime.py",  # transport seam implementation
    }
    found: set[str] = set()
    for path in (root / "app").rglob("*.py"):
        if ".radio_operation(" in path.read_text(encoding="utf-8"):
            found.add(path.relative_to(root).as_posix())

    assert found == allowed


def test_radio_stats_samples_have_distinct_low_priority_job_kind():
    """Read-only health polling must never appear as destructive periodic sync."""
    assert producers.classify_operation("radio_stats_sample") == (
        RadioJobKind.RADIO_STATS_SAMPLE,
        RadioJobPriority.LOW,
    )
    assert producers.classify_operation("periodic_sync") == (
        RadioJobKind.PERIODIC_SYNC,
        RadioJobPriority.LOW,
    )


@pytest.mark.parametrize(
    ("operation", "expected_kind", "expected_timeout"),
    [
        ("discover_mesh", RadioJobKind.DISCOVERY, 20),
        ("discover_regions", RadioJobKind.DISCOVERY, 120),
        ("radio_trace", RadioJobKind.TRACE, 60),
        ("request_trace", RadioJobKind.TRACE, 60),
        ("request_path_discovery", RadioJobKind.DISCOVERY, 45),
        ("contact_telemetry", RadioJobKind.CONTACT_QUERY, 45),
        ("repeater_status", RadioJobKind.SERVER_QUERY, 55),
        ("repeater_node_info", RadioJobKind.SERVER_QUERY, 120),
        ("room_status", RadioJobKind.SERVER_QUERY, 45),
        ("debug_support_snapshot", RadioJobKind.RADIO_QUERY, 60),
    ],
)
def test_user_radio_operations_have_visible_kinds_and_bounded_deadlines(
    operation, expected_kind, expected_timeout
):
    assert producers.classify_operation(operation) == (
        expected_kind,
        RadioJobPriority.NORMAL,
    )
    assert producers.command_timeout_for_operation(operation) == expected_timeout
