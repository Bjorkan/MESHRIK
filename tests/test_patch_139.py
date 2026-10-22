import asyncio

import pytest

import app.radio_sync as radio_sync


@pytest.mark.asyncio
async def test_waiting_push_during_catchup_rearms_one_worker(monkeypatch):
    from types import SimpleNamespace

    first_started = asyncio.Event()
    release_first = asyncio.Event()
    active = 0
    peak = 0
    generations = []

    async def fake_drain(generation):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        generations.append(generation)
        if len(generations) == 1:
            first_started.set()
            await release_first.wait()
        active -= 1

    fake_radio = SimpleNamespace(is_connected=True, radio_generation=7)
    monkeypatch.setattr(radio_sync, "radio_manager", fake_radio)
    monkeypatch.setattr(radio_sync, "_run_inbound_catchup", fake_drain)
    radio_sync._inbound_catchup_task = None
    radio_sync._inbound_catchup_retrigger_generation = None
    try:
        radio_sync.request_inbound_catchup()
        await asyncio.wait_for(first_started.wait(), timeout=1)
        for _ in range(100):
            radio_sync.request_inbound_catchup()
        release_first.set()
        for _ in range(25):
            await asyncio.sleep(0)
            if len(generations) == 2 and radio_sync._inbound_catchup_task is None:
                break
        assert generations == [7, 7]
        assert peak == 1
    finally:
        await radio_sync.stop_inbound_catchup()


@pytest.mark.asyncio
async def test_pending_wakeup_is_fenced_across_reconnect(monkeypatch):
    from types import SimpleNamespace

    release = asyncio.Event()
    first_started = asyncio.Event()
    called = []

    async def fake_drain(generation):
        called.append(generation)
        first_started.set()
        await release.wait()

    radio = SimpleNamespace(is_connected=True, radio_generation=12)
    monkeypatch.setattr(radio_sync, "radio_manager", radio)
    monkeypatch.setattr(radio_sync, "_run_inbound_catchup", fake_drain)
    radio_sync._inbound_catchup_task = None
    radio_sync._inbound_catchup_retrigger_generation = None
    try:
        radio_sync.request_inbound_catchup()
        await first_started.wait()
        radio_sync.request_inbound_catchup()
        radio.radio_generation = 13
        release.set()
        for _ in range(10):
            await asyncio.sleep(0)
        assert called == [12]
    finally:
        await radio_sync.stop_inbound_catchup()
