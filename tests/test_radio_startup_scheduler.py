"""Hardware-free acceptance tests for scheduler-owned startup (#48/#49)."""

import asyncio
from contextlib import suppress
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from meshcore import EventType

from app.config import StartupPolicy, settings
from app.radio import RadioManager
from app.services.radio_job_scheduler import RadioJobScheduler, RadioQueueUnavailableError
from app.services.radio_job_worker import RadioCommandOutcome, RadioJobWorker
from app.services.radio_jobs import RadioJobKind, RadioJobState
from app.services.radio_lifecycle import LifecycleStageError, run_post_connect_setup
from app.services.radio_runtime import RadioRuntime


def _device() -> MagicMock:
    mc = MagicMock()
    mc.is_connected = True
    mc._reader.handle_rx = AsyncMock()
    mc.commands.send_device_query = AsyncMock(
        return_value=SimpleNamespace(payload={"fw ver": 13, "max_channels": 2})
    )
    mc.commands.get_time = AsyncMock(return_value=SimpleNamespace(payload={"time": 1000}))
    mc.disconnect = AsyncMock()
    return mc


async def _prepare(monkeypatch, policy=StartupPolicy.FULL):
    monkeypatch.setattr(settings, "startup_policy", policy)
    monkeypatch.setattr(
        "app.radio_sync.sync_contacts_from_radio",
        AsyncMock(return_value={"synced": 0, "radio_contacts": {}}),
    )
    monkeypatch.setattr(
        "app.radio_sync.sync_channels_from_radio",
        AsyncMock(return_value={"synced": 0, "cleared": 0}),
    )
    for name in (
        "startup_export_private_key",
        "startup_sync_clock",
        "startup_apply_flood_scope",
        "startup_send_advertisement",
        "startup_drain_messages",
        "startup_reconcile_contacts",
        "startup_clear_channel_slots",
        "startup_allow_periodic_offload",
        "startup_enable_telemetry_collection",
    ):
        monkeypatch.setattr(settings, name, False)
    manager = RadioManager()
    manager._meshcore = _device()
    manager.radio_generation = 1
    manager.readiness_state = "connecting"
    scheduler = RadioJobScheduler()
    worker = RadioJobWorker(scheduler, runtime=RadioRuntime(manager), poll_interval_seconds=0.002)
    monkeypatch.setattr("app.services.radio_job_worker.radio_job_worker", worker)
    worker.start()
    return manager, scheduler, worker


@pytest.mark.asyncio
async def test_full_bootstrap_runs_as_worker_jobs_and_blocks_user_admission(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()

    async def device_query():
        entered.set()
        await release.wait()
        return SimpleNamespace(payload={"fw ver": 13, "max_channels": 2})

    manager.meshcore.commands.send_device_query.side_effect = device_query
    try:
        with patch("app.event_handlers.register_event_handlers"):
            task = asyncio.create_task(run_post_connect_setup(manager))
            await asyncio.wait_for(entered.wait(), 2)
            assert manager.readiness_state == "initializing"
            assert scheduler.list_jobs()[0].kind == RadioJobKind.LIFECYCLE_DEVICE_INFO
            assert scheduler.list_jobs()[0].state == RadioJobState.EXECUTING
            with pytest.raises(RadioQueueUnavailableError):
                worker.submit(
                    RadioJobKind.RADIO_QUERY,
                    AsyncMock(return_value=RadioCommandOutcome.FINISHED),
                )
            release.set()
            await asyncio.wait_for(task, 2)
        assert manager.readiness_state == "ready"
        assert manager.is_setup_complete
        assert manager.startup_stage == "complete"
        assert all(job.state == RadioJobState.COMPLETED for job in scheduler.list_jobs())
        assert [job.kind for job in scheduler.list_jobs()] == [
            RadioJobKind.LIFECYCLE_DEVICE_INFO,
            RadioJobKind.LIFECYCLE_CONTACT_SYNC,
            RadioJobKind.LIFECYCLE_CHANNEL_SYNC,
            RadioJobKind.LIFECYCLE_AUTO_FETCH,
        ]
        manager.meshcore.commands.set_time.assert_not_called()
        manager.meshcore.commands.send_advert.assert_not_called()
    finally:
        release.set()
        await worker.stop()


@pytest.mark.asyncio
async def test_failed_device_bootstrap_never_admits_user_jobs(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch)
    manager.meshcore.commands.send_device_query.side_effect = RuntimeError("fault")
    try:
        with patch("app.event_handlers.register_event_handlers"):
            with pytest.raises(LifecycleStageError):
                await asyncio.wait_for(run_post_connect_setup(manager), 2)
        assert manager.readiness_state == "failed"
        assert manager.startup_stage == "recovery_required"
        assert not manager.is_setup_complete
        assert not manager.is_setup_in_progress
        assert scheduler.list_jobs()[0].state == RadioJobState.UNKNOWN
        with pytest.raises(RadioQueueUnavailableError):
            worker.submit(RadioJobKind.RADIO_QUERY, AsyncMock())
    finally:
        await worker.stop()


@pytest.mark.asyncio
async def test_full_baseline_reads_but_cannot_offload_or_advertise(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch, StartupPolicy.FULL)
    contacts = AsyncMock(return_value={"synced": 1, "radio_contacts": {}})
    channels = AsyncMock(return_value={"synced": 1, "cleared": 0})
    with (
        patch("app.event_handlers.register_event_handlers"),
        patch("app.radio_sync.sync_contacts_from_radio", contacts),
        patch("app.radio_sync.sync_channels_from_radio", channels),
        patch("app.radio_sync.sync_and_offload_channels", new_callable=AsyncMock) as offload,
        patch("app.radio_sync.send_advertisement", new_callable=AsyncMock) as advert,
        patch("app.radio_sync.sync_radio_time", new_callable=AsyncMock) as clock,
        patch("app.keystore.export_and_store_private_key", new_callable=AsyncMock) as key,
    ):
        try:
            await asyncio.wait_for(run_post_connect_setup(manager), 2)
            assert manager.readiness_state == "ready"
            assert all(job.state == RadioJobState.COMPLETED for job in scheduler.list_jobs())
            assert len(scheduler.list_jobs()) == 4
            contacts.assert_awaited_once()
            channels.assert_awaited_once()
            for mutation in (offload, advert, clock, key):
                mutation.assert_not_awaited()
            manager.meshcore.commands.set_channel.assert_not_called()
            manager.meshcore.commands.reboot.assert_not_called()
        finally:
            await worker.stop()


@pytest.mark.asyncio
async def test_full_policy_without_individual_permissions_emits_no_radio_writes(monkeypatch):
    manager, _, worker = await _prepare(monkeypatch, StartupPolicy.FULL)
    with (
        patch("app.event_handlers.register_event_handlers"),
        patch(
            "app.radio_sync.sync_contacts_from_radio",
            new_callable=AsyncMock,
            return_value={"synced": 0, "radio_contacts": {}},
        ),
        patch(
            "app.radio_sync.sync_channels_from_radio",
            new_callable=AsyncMock,
            return_value={"synced": 0, "cleared": 0},
        ),
        patch("app.radio_sync.send_advertisement", new_callable=AsyncMock) as advert,
        patch("app.radio_sync.sync_and_offload_channels", new_callable=AsyncMock) as clear,
        patch("app.radio_sync.start_periodic_sync") as periodic,
        patch("app.radio_sync.request_inbound_catchup") as catchup,
    ):
        try:
            await asyncio.wait_for(run_post_connect_setup(manager), 2)
            assert manager.readiness_state == "ready"
            advert.assert_not_awaited()
            clear.assert_not_awaited()
            periodic.assert_not_called()
            catchup.assert_not_called()
            manager.meshcore.commands.set_channel.assert_not_called()
        finally:
            await worker.stop()


@pytest.mark.asyncio
async def test_disconnect_during_stage_cancels_remaining_stages(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()

    async def device_query():
        entered.set()
        await release.wait()
        return SimpleNamespace(payload={"fw ver": 13})

    manager.meshcore.commands.send_device_query.side_effect = device_query
    mc = manager.meshcore
    with patch("app.event_handlers.register_event_handlers"):
        task = asyncio.create_task(run_post_connect_setup(manager))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            disconnect = asyncio.create_task(manager.disconnect())
            await asyncio.sleep(0.02)
            assert not disconnect.done()  # teardown cannot race command lock
            release.set()
            with suppress(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
            await asyncio.wait_for(disconnect, 2)
            assert manager.meshcore is None
            assert manager.readiness_state == "disconnected"
            assert not manager.is_setup_complete
            assert manager.radio_generation == 2
            assert (
                len(
                    [
                        j
                        for j in scheduler.list_jobs()
                        if j.kind == RadioJobKind.LIFECYCLE_AUTO_FETCH
                    ]
                )
                == 0
            )
            mc.disconnect.assert_awaited_once()
        finally:
            release.set()
            if not task.done():
                task.cancel()
            await worker.stop()


@pytest.mark.asyncio
async def test_readonly_contact_snapshot_keeps_radio_residency(monkeypatch):
    from app.radio_sync import sync_contacts_from_radio
    from app.repository import ContactRepository

    contact = {"b" * 64: {"adv_name": "Test", "flags": 0}}
    mc = MagicMock()
    mc.commands.get_contacts = AsyncMock(
        return_value=SimpleNamespace(type=EventType.OK, payload=contact)
    )
    upsert = AsyncMock()
    monkeypatch.setattr(ContactRepository, "upsert", upsert)
    monkeypatch.setattr("app.radio_sync._reconcile_contact_messages_background", AsyncMock())
    result = await sync_contacts_from_radio(mc)
    assert result["synced"] == 1
    upsert.assert_awaited_once()
    assert upsert.await_args.args[0].on_radio is True


@pytest.mark.asyncio
async def test_production_startup_refuses_to_bypass_a_missing_worker(monkeypatch):
    """Isolated test-only direct-lock seam must fail closed outside pytest."""
    manager, _, worker = await _prepare(monkeypatch)
    await worker.stop()
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    with pytest.raises(RadioQueueUnavailableError):
        await run_post_connect_setup(manager)
    assert manager.readiness_state == "failed"
    assert not manager.is_setup_complete
    manager.meshcore.commands.send_device_query.assert_not_awaited()


@pytest.mark.asyncio
async def test_concurrent_duplicate_startup_events_coalesce_per_generation(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()

    async def blocking_query():
        entered.set()
        await release.wait()
        return SimpleNamespace(payload={"fw ver": 13, "max_channels": 2})

    manager.meshcore.commands.send_device_query.side_effect = blocking_query
    with patch("app.event_handlers.register_event_handlers"):
        first = asyncio.create_task(run_post_connect_setup(manager))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            second = asyncio.create_task(run_post_connect_setup(manager, force=True))
            await asyncio.sleep(0.02)
            assert len(scheduler.list_jobs()) == 1
            release.set()
            await asyncio.wait_for(asyncio.gather(first, second), 2)
            assert [j.kind for j in scheduler.list_jobs()] == [
                RadioJobKind.LIFECYCLE_DEVICE_INFO,
                RadioJobKind.LIFECYCLE_CONTACT_SYNC,
                RadioJobKind.LIFECYCLE_CHANNEL_SYNC,
                RadioJobKind.LIFECYCLE_AUTO_FETCH,
            ]
            manager.meshcore.commands.send_device_query.assert_awaited_once()
        finally:
            release.set()
            await worker.stop()


@pytest.mark.asyncio
async def test_partial_contact_snapshot_failure_is_degraded_not_ready(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch, StartupPolicy.FULL)

    async def partial_contact_failure(_mc):
        raise RuntimeError("database failure after first contact")

    with (
        patch("app.event_handlers.register_event_handlers"),
        patch("app.radio_sync.sync_contacts_from_radio", side_effect=partial_contact_failure),
        patch(
            "app.radio_sync.sync_channels_from_radio",
            new_callable=AsyncMock,
            return_value={"synced": 1, "cleared": 0},
        ) as channels,
        patch("app.radio_sync.sync_and_offload_channels", new_callable=AsyncMock) as offload,
    ):
        try:
            await asyncio.wait_for(run_post_connect_setup(manager), 2)
            assert manager.readiness_state == "degraded"
            assert manager.startup_stage == "recovery_required"
            assert manager.startup_error_stage == "contact_sync"
            assert manager.is_setup_complete
            assert [j.kind for j in scheduler.list_jobs()] == [
                RadioJobKind.LIFECYCLE_DEVICE_INFO,
                RadioJobKind.LIFECYCLE_CONTACT_SYNC,
                RadioJobKind.LIFECYCLE_CHANNEL_SYNC,
                RadioJobKind.LIFECYCLE_AUTO_FETCH,
            ]
            channels.assert_awaited_once()
            offload.assert_not_awaited()
            manager.meshcore.commands.set_channel.assert_not_called()
        finally:
            await worker.stop()


@pytest.mark.asyncio
async def test_repeated_idle_disconnect_and_reconnect_has_one_workflow_each(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch)
    with patch("app.event_handlers.register_event_handlers"):
        try:
            for expected_generation in (1, 3, 5):
                assert manager.radio_generation == expected_generation
                await asyncio.wait_for(run_post_connect_setup(manager), 2)
                jobs = [
                    j for j in scheduler.list_jobs() if j.radio_generation == expected_generation
                ]
                assert [j.kind for j in jobs] == [
                    RadioJobKind.LIFECYCLE_DEVICE_INFO,
                    RadioJobKind.LIFECYCLE_CONTACT_SYNC,
                    RadioJobKind.LIFECYCLE_CHANNEL_SYNC,
                    RadioJobKind.LIFECYCLE_AUTO_FETCH,
                ]
                assert all(j.state == RadioJobState.COMPLETED for j in jobs)
                await asyncio.wait_for(manager.disconnect(), 2)
                manager._meshcore = _device()
                manager.radio_generation += 1
                manager.readiness_state = "connecting"
            assert all(
                j.state in {RadioJobState.COMPLETED, RadioJobState.CANCELLED}
                for j in scheduler.list_jobs()
            )
        finally:
            await worker.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("policy", "flag", "expected_stage"),
    [
        (StartupPolicy.FULL, "startup_send_advertisement", RadioJobKind.LIFECYCLE_ADVERTISEMENT),
        (StartupPolicy.FULL, "startup_sync_clock", RadioJobKind.LIFECYCLE_CLOCK_SYNC),
        (StartupPolicy.FULL, "startup_export_private_key", RadioJobKind.LIFECYCLE_KEY_EXPORT),
        (StartupPolicy.FULL, "startup_clear_channel_slots", RadioJobKind.LIFECYCLE_CHANNEL_CLEAR),
        (StartupPolicy.FULL, "startup_drain_messages", RadioJobKind.LIFECYCLE_MESSAGE_DRAIN),
    ],
)
async def test_startup_policy_selectively_admits_only_the_consented_command(
    monkeypatch,
    policy,
    flag,
    expected_stage,
):
    manager, scheduler, worker = await _prepare(monkeypatch, policy)
    monkeypatch.setattr(settings, flag, True)
    with (
        patch("app.event_handlers.register_event_handlers"),
        patch(
            "app.radio_sync.sync_contacts_from_radio",
            new_callable=AsyncMock,
            return_value={"synced": 0, "radio_contacts": {}},
        ),
        patch(
            "app.radio_sync.sync_channels_from_radio",
            new_callable=AsyncMock,
            return_value={"synced": 0, "cleared": 0},
        ),
        patch(
            "app.radio_sync.sync_and_offload_channels",
            new_callable=AsyncMock,
            return_value={"synced": 0, "cleared": 0},
        ) as clear,
        patch("app.radio_sync.sync_radio_time", new_callable=AsyncMock, return_value=True) as clock,
        patch("app.radio_sync.send_advertisement", new_callable=AsyncMock) as advert,
        patch("app.radio_sync.drain_pending_messages", new_callable=AsyncMock) as drain,
        patch("app.keystore.export_and_store_private_key", new_callable=AsyncMock) as export,
        patch("app.radio_sync.start_periodic_advert"),
        patch("app.radio_sync.start_message_polling"),
        patch("app.radio_sync.start_periodic_sync"),
    ):
        try:
            await asyncio.wait_for(run_post_connect_setup(manager), 2)
            kinds = [job.kind for job in scheduler.list_jobs()]
            if expected_stage is not None:
                assert kinds.count(expected_stage) == 1
            allowed = [
                j
                for j in kinds
                if j
                in {
                    RadioJobKind.LIFECYCLE_KEY_EXPORT,
                    RadioJobKind.LIFECYCLE_CLOCK_SYNC,
                    RadioJobKind.LIFECYCLE_ADVERTISEMENT,
                    RadioJobKind.LIFECYCLE_CHANNEL_CLEAR,
                    RadioJobKind.LIFECYCLE_MESSAGE_DRAIN,
                }
            ]
            assert allowed == ([expected_stage] if expected_stage is not None else [])
            for kind, operation in (
                (RadioJobKind.LIFECYCLE_ADVERTISEMENT, advert),
                (RadioJobKind.LIFECYCLE_CLOCK_SYNC, clock),
                (RadioJobKind.LIFECYCLE_KEY_EXPORT, export),
                (RadioJobKind.LIFECYCLE_CHANNEL_CLEAR, clear),
            ):
                assert operation.await_count == (1 if expected_stage == kind else 0)
            assert drain.await_count == (
                1 if expected_stage == RadioJobKind.LIFECYCLE_MESSAGE_DRAIN else 0
            )
            assert manager.readiness_state == "ready"
        finally:
            await worker.stop()


@pytest.mark.asyncio
async def test_manual_force_retry_recovers_degraded_generation_using_worker(monkeypatch):
    from app.services.radio_lifecycle import prepare_connected_radio

    manager, scheduler, worker = await _prepare(monkeypatch, StartupPolicy.FULL)
    contacts = AsyncMock(
        side_effect=[
            RuntimeError("partial DB error"),
            {
                "synced": 2,
                "radio_contacts": {},
            },
        ]
    )
    channels = AsyncMock(return_value={"synced": 1, "cleared": 0})
    with (
        patch("app.event_handlers.register_event_handlers"),
        patch("app.radio_sync.sync_contacts_from_radio", contacts),
        patch("app.radio_sync.sync_channels_from_radio", channels),
        patch("app.websocket.broadcast_health"),
    ):
        try:
            await run_post_connect_setup(manager)
            assert manager.readiness_state == "degraded"
            assert manager.startup_error_stage == "contact_sync"
            previous = len(scheduler.list_jobs())
            assert await prepare_connected_radio(manager, broadcast_on_success=False, force=True)
            assert manager.readiness_state == "ready"
            assert manager.startup_error_stage is None
            assert contacts.await_count == 2
            assert len(scheduler.list_jobs()) == previous + 4
            assert all(j.kind.name.startswith("LIFECYCLE_") for j in scheduler.list_jobs())
        finally:
            await worker.stop()


@pytest.mark.asyncio
async def test_disconnect_during_channel_sync_fences_old_generation(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch, StartupPolicy.FULL)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def channel_snapshot(_mc):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await release.wait()
        return {"synced": 1, "cleared": 0}

    with (
        patch("app.event_handlers.register_event_handlers"),
        patch(
            "app.radio_sync.sync_contacts_from_radio",
            new_callable=AsyncMock,
            return_value={"synced": 0, "radio_contacts": {}},
        ),
        patch("app.radio_sync.sync_channels_from_radio", side_effect=channel_snapshot),
    ):
        startup = asyncio.create_task(run_post_connect_setup(manager))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            old_generation = manager.radio_generation
            disconnect = asyncio.create_task(manager.disconnect())
            await asyncio.sleep(0.02)
            release.set()
            with suppress(asyncio.CancelledError):
                await asyncio.wait_for(startup, 2)
            await asyncio.wait_for(disconnect, 2)
            assert manager.radio_generation > old_generation
            assert all(
                j.kind != RadioJobKind.LIFECYCLE_AUTO_FETCH
                for j in scheduler.list_jobs()
                if j.radio_generation == old_generation
            )
            # Simulate a separately created transport; never call real hardware.
            manager._meshcore = _device()
            manager.radio_generation += 1
            manager.readiness_state = "connecting"
            await asyncio.wait_for(run_post_connect_setup(manager), 2)
            assert manager.readiness_state == "ready"
            assert calls == 2
            assert all(
                j.state
                in {
                    RadioJobState.COMPLETED,
                    RadioJobState.UNKNOWN,
                    RadioJobState.FAILED,
                    RadioJobState.CANCELLED,
                }
                for j in scheduler.list_jobs()
            )
        finally:
            release.set()
            if not startup.done():
                startup.cancel()
            await worker.stop()


@pytest.mark.asyncio
async def test_full_policy_with_all_optins_dispatches_only_worker_lifecycle_stages(monkeypatch):
    manager, scheduler, worker = await _prepare(monkeypatch, StartupPolicy.FULL)
    for flag in (
        "startup_export_private_key",
        "startup_sync_clock",
        "startup_apply_flood_scope",
        "startup_send_advertisement",
        "startup_drain_messages",
        "startup_reconcile_contacts",
        "startup_clear_channel_slots",
        "startup_allow_periodic_offload",
        "startup_enable_telemetry_collection",
    ):
        monkeypatch.setattr(settings, flag, True)
    with (
        patch("app.event_handlers.register_event_handlers"),
        patch(
            "app.radio_sync.sync_contacts_from_radio",
            new_callable=AsyncMock,
            return_value={"synced": 0, "radio_contacts": {}},
        ),
        patch("app.radio_sync.sync_channels_from_radio", new_callable=AsyncMock) as snapshot,
        patch(
            "app.radio_sync.sync_and_offload_channels",
            new_callable=AsyncMock,
            return_value={"synced": 1, "cleared": 1},
        ) as clear,
        patch("app.radio_sync.sync_radio_time", new_callable=AsyncMock, return_value=True) as clock,
        patch("app.radio_sync.send_advertisement", new_callable=AsyncMock) as advert,
        patch("app.radio_sync.drain_pending_messages", new_callable=AsyncMock) as drain,
        patch("app.keystore.export_and_store_private_key", new_callable=AsyncMock) as export,
        patch("app.services.flood_scope.set_radio_flood_scope", new_callable=AsyncMock) as flood,
        patch(
            "app.repository.AppSettingsRepository.get",
            new_callable=AsyncMock,
            return_value=SimpleNamespace(flood_scope=""),
        ),
        patch("app.radio_sync.start_periodic_sync") as periodic,
        patch("app.radio_sync.start_periodic_advert") as periodic_advert,
        patch("app.radio_sync.start_message_polling") as message_poll,
        patch("app.radio_sync.start_telemetry_collect") as telemetry,
        patch("app.radio_sync.start_background_contact_reconciliation") as reconcile,
    ):
        try:
            await asyncio.wait_for(run_post_connect_setup(manager), 2)
            assert manager.readiness_state == "ready"
            assert [j.kind for j in scheduler.list_jobs()] == [
                RadioJobKind.LIFECYCLE_DEVICE_INFO,
                RadioJobKind.LIFECYCLE_MESSAGE_DRAIN,
                RadioJobKind.LIFECYCLE_CONTACT_SYNC,
                RadioJobKind.LIFECYCLE_CHANNEL_CLEAR,
                RadioJobKind.LIFECYCLE_KEY_EXPORT,
                RadioJobKind.LIFECYCLE_CLOCK_SYNC,
                RadioJobKind.LIFECYCLE_FLOOD_SCOPE,
                RadioJobKind.LIFECYCLE_ADVERTISEMENT,
                RadioJobKind.LIFECYCLE_AUTO_FETCH,
            ]
            for action in (clear, clock, advert, drain, export, flood):
                action.assert_awaited_once()
            snapshot.assert_not_awaited()  # Channel clearing replaces safe snapshot.
            for start in (periodic, periodic_advert, message_poll, telemetry, reconcile):
                start.assert_called_once()
            assert all(j.state == RadioJobState.COMPLETED for j in scheduler.list_jobs())
        finally:
            await worker.stop()
