"""Health refreshes must not masquerade as connection changes."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import app.websocket as websocket
from app.services.radio_job_worker import radio_job_scheduler


@pytest.mark.asyncio
async def test_repeated_health_stats_do_not_create_connection_activity(monkeypatch):
    monkeypatch.setattr(websocket, "_last_radio_activity_status", None)
    with (
        patch("app.routers.health.build_health_data", new_callable=AsyncMock) as build,
        patch.object(websocket.ws_manager, "broadcast", new_callable=AsyncMock),
    ):
        # The real radio_runtime seam is resolved inside broadcast_health.
        from app.services import radio_runtime as runtime_module

        monkeypatch.setattr(runtime_module.radio_runtime.manager, "readiness_state", "ready")
        monkeypatch.setattr(runtime_module.radio_runtime.manager, "radio_generation", 42)
        build.return_value = {"radio_connected": True}
        first = len(radio_job_scheduler._activities)
        websocket.broadcast_health(True)
        await asyncio.sleep(0)
        initial = list(radio_job_scheduler._activities)[first:]
        assert len(initial) == 1
        assert initial[0].previous_connected is None
        assert initial[0].connected is True
        assert initial[0].readiness == "ready"
        assert initial[0].radio_generation == 42

        baseline = len(radio_job_scheduler._activities)
        for _ in range(5):
            websocket.broadcast_health(True)
        await asyncio.sleep(0)
        assert len(radio_job_scheduler._activities) == baseline

        websocket.broadcast_health(False)
        await asyncio.sleep(0)
        disconnected = list(radio_job_scheduler._activities)[-1]
        assert disconnected.previous_connected is True
        assert disconnected.connected is False
        assert disconnected.previous_readiness == "ready"
        assert disconnected.readiness == "disconnected"

        monkeypatch.setattr(runtime_module.radio_runtime.manager, "readiness_state", "initializing")
        monkeypatch.setattr(runtime_module.radio_runtime.manager, "radio_generation", 43)
        websocket.broadcast_health(True)
        await asyncio.sleep(0)
        reconnected = list(radio_job_scheduler._activities)[-1]
        assert reconnected.previous_connected is False
        assert reconnected.connected is True
        assert reconnected.previous_readiness == "disconnected"
        assert reconnected.readiness == "initializing"
        assert reconnected.radio_generation == 43

        monkeypatch.setattr(runtime_module.radio_runtime.manager, "_connection_desired", False)
        websocket.broadcast_health(False)
        await asyncio.sleep(0)
        paused = list(radio_job_scheduler._activities)[-1]
        assert paused.previous_readiness == "initializing"
        assert paused.readiness == "paused"


@pytest.mark.asyncio
async def test_periodic_health_ws_replay_does_not_evict_bounded_activity(monkeypatch):
    """Health remains live over WS without consuming event history every minute."""
    from app.services import radio_job_worker
    from app.services import radio_runtime as runtime_module
    from app.services.radio_job_scheduler import RadioJobScheduler
    from app.services.radio_jobs import RadioActivityKind

    scheduler = RadioJobScheduler(event_limit=3)
    observed = []
    unsubscribe = scheduler.subscribe_activity(observed.append)
    monkeypatch.setattr(radio_job_worker, "radio_job_scheduler", scheduler)
    monkeypatch.setattr(websocket, "_last_radio_activity_status", None)
    manager = runtime_module.radio_runtime.manager
    monkeypatch.setattr(manager, "_connection_desired", True)
    monkeypatch.setattr(manager, "readiness_state", "ready")
    monkeypatch.setattr(manager, "radio_generation", 99)

    with (
        patch("app.routers.health.build_health_data", new_callable=AsyncMock) as build,
        patch.object(websocket.ws_manager, "broadcast", new_callable=AsyncMock) as ws_send,
    ):
        build.return_value = {"radio_connected": True, "radio_state": "ready"}
        # One initial observation followed by many periodic stats/other health
        # pushes. All must reach WebSocket clients, but none are transitions.
        for _ in range(120):
            websocket.broadcast_health(True)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert ws_send.await_count == 120
        assert all(call.args[0] == "health" for call in ws_send.await_args_list)
        assert len(observed) == 1
        assert observed[0].kind == RadioActivityKind.CONNECTION_CHANGED
        assert [record.sequence for record in scheduler._activities] == [observed[0].sequence]
        assert scheduler._activity_dropped_through == 0

        # A genuine disconnect is still immediately visible to subscribers.
        websocket.broadcast_health(False)
        await asyncio.sleep(0)
        assert ws_send.await_count == 121
        assert len(observed) == 2
        assert observed[-1].previous_readiness == "ready"
        assert observed[-1].readiness == "disconnected"
        assert len(scheduler._activities) == 2
        assert scheduler._activity_dropped_through == 0

    unsubscribe()
