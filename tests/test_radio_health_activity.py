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
