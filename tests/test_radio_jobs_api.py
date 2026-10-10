"""REST snapshots, bounded sanitized activity and WS event contracts (#41)."""

import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.events import dump_ws_event
from app.services.radio_job_scheduler import RadioJobScheduler
from app.services.radio_job_worker import RadioJobWorker
from app.services.radio_jobs import RadioActivityKind, RadioJobKind, RadioJobState


@pytest.fixture
def isolated_api(monkeypatch):
    import app.routers.radio_jobs as router

    queue = RadioJobScheduler(capacity=8, history_limit=4, event_limit=3)
    worker = RadioJobWorker(queue)
    runtime = SimpleNamespace(
        manager=SimpleNamespace(_operation_lock=asyncio.Lock()),
        is_connected=True,
        is_setup_in_progress=False,
        is_reconnecting=False,
    )
    monkeypatch.setattr(router, "radio_job_scheduler", queue)
    monkeypatch.setattr(router, "radio_job_worker", worker)
    monkeypatch.setattr(router, "radio_runtime", runtime)
    return queue


@pytest.mark.asyncio
async def test_api_paginate_cancel_idempotent_and_no_generic_command_endpoint(client, isolated_api):
    queue = isolated_api
    jobs = [queue.submit(RadioJobKind.RADIO_QUERY) for _ in range(3)]
    first = await client.get("/api/radio/jobs", params={"limit": 2})
    assert first.status_code == 200
    body = first.json()
    assert [j["id"] for j in body["items"]] == [str(jobs[2].id), str(jobs[1].id)]
    assert body["has_more"] is True
    assert body["radio"]["radio_status"] == "connected"
    assert body["radio"]["physical_rf_state"] == "unavailable"
    next_page = await client.get(
        "/api/radio/jobs", params={"limit": 2, "cursor": body["next_cursor"]}
    )
    assert [j["id"] for j in next_page.json()["items"]] == [str(jobs[0].id)]

    detail = await client.get(f"/api/radio/jobs/{jobs[0].id}")
    assert detail.status_code == 200
    assert detail.json()["kind"] == "radio_query"
    cancel = await client.post(f"/api/radio/jobs/{jobs[0].id}/cancel")
    assert cancel.status_code == 200
    assert cancel.json()["action"] == "cancelled_before_dispatch"
    assert cancel.json()["job"]["state"] == "cancelled"
    repeated = await client.post(f"/api/radio/jobs/{jobs[0].id}/cancel")
    assert repeated.json()["action"] == "unchanged"
    no_generic = await client.post(
        "/api/radio/jobs", json={"command": "send_raw", "body": "secret"}
    )
    assert no_generic.status_code == 405
    assert (await client.get(f"/api/radio/jobs/{uuid4()}")).status_code == 404
    assert (await client.post(f"/api/radio/jobs/{uuid4()}/cancel")).status_code == 404
    for params in ({"limit": 0}, {"limit": 101}, {"cursor": -1}, {"status": "secret"}):
        assert (await client.get("/api/radio/jobs", params=params)).status_code == 422


@pytest.mark.asyncio
async def test_api_stop_waiting_executing_and_terminal_unknown_distinct(client, isolated_api):
    queue = isolated_api
    login = queue.submit(RadioJobKind.REPEATER_LOGIN)
    queue.take_next()
    queue.transition(login.id, RadioJobState.AWAITING_RESPONSE)
    response = await client.post(f"/api/radio/jobs/{login.id}/cancel")
    assert response.json()["action"] == "stop_waiting"
    assert response.json()["job"]["result"] == "stopped_waiting"
    assert response.json()["job"]["stage"] == "cancelled"
    sending = queue.submit(RadioJobKind.DIRECT_MESSAGE)
    queue.take_next()
    response = await client.post(f"/api/radio/jobs/{sending.id}/cancel")
    assert response.json()["action"] == "requested"
    assert response.json()["job"]["state"] == "executing"
    assert response.json()["job"]["cancellation_requested"] is True


@pytest.mark.asyncio
async def test_activity_is_bounded_replayable_and_free_of_raw_fields(client, isolated_api):
    queue = isolated_api
    for _ in range(5):
        queue.record_activity(RadioActivityKind.PACKET_RECEIVED)
    recent = await client.get("/api/radio/activity", params={"limit": 2})
    assert recent.status_code == 200
    assert [r["sequence"] for r in recent.json()["items"]] == [4, 5]
    replay = await client.get("/api/radio/activity", params={"cursor": 1, "limit": 2})
    assert replay.json()["gap"] is True
    assert [r["sequence"] for r in replay.json()["items"]] == [3, 4]
    assert replay.json()["has_more"] is True
    later = await client.get("/api/radio/activity", params={"cursor": 4})
    assert [r["sequence"] for r in later.json()["items"]] == [5]
    assert (await client.get("/api/radio/activity", params={"limit": 0})).status_code == 422
    assert (await client.get("/api/radio/activity", params={"cursor": -1})).status_code == 422
    assert all(item["source"] == "raw_rf_log" for item in recent.json()["items"])
    assert "payload" not in json.dumps(recent.json())
    assert "message" not in json.dumps(recent.json())
    with pytest.raises(ValueError):
        queue.record_activity("raw secrets here")


def test_ws_contract_deltas_are_typed_and_fail_closed_for_private_fields(isolated_api):
    job = isolated_api.submit(RadioJobKind.REPEATER_LOGIN)
    activity = isolated_api.record_activity(RadioActivityKind.LOGIN_RESPONSE, job_id=job.id)
    for event_type, body in (
        ("radio_job", job.model_dump(mode="json")),
        ("radio_activity", activity.model_dump(mode="json")),
    ):
        envelope = json.loads(dump_ws_event(event_type, body))
        assert envelope["type"] == event_type
        assert "private_key" not in json.dumps(envelope)
        assert "message_body" not in json.dumps(envelope)
    with pytest.raises(ValueError):
        dump_ws_event("radio_activity", {**activity.model_dump(), "password": "secret"})
    with pytest.raises(ValueError):
        dump_ws_event("radio_job", {**job.model_dump(), "text": "secret"})
