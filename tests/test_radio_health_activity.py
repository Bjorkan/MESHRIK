"""Health refreshes must not masquerade as connection changes."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

import app.websocket as websocket
from app.services.radio_job_worker import radio_job_scheduler
from app.services.radio_jobs import RadioActivityKind


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
        for _ in range(6):
            websocket.broadcast_health(True)
        await asyncio.sleep(0)
        new = list(radio_job_scheduler._activities)[first:]
        assert sum(x.kind == RadioActivityKind.CONNECTION_CHANGED for x in new) == 1
        websocket.broadcast_health(False)
        await asyncio.sleep(0)
        newer = list(radio_job_scheduler._activities)[first:]
        assert sum(x.kind == RadioActivityKind.CONNECTION_CHANGED for x in newer) == 2
