"""Deterministic radio-state matrix for channel residency (issue #87)."""

from collections import OrderedDict
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from meshcore import EventType

from app.models import SendChannelMessageRequest
from app.radio import radio_manager
from app.radio_sync import audit_channel_send_cache, sync_channels_from_radio
from app.repository import ChannelRepository
from app.routers.channels import CreateChannelRequest, create_channel
from app.routers.messages import send_channel_message


def _result(event_type: EventType, payload=None):
    return SimpleNamespace(type=event_type, payload=payload or {})


class FakeChannelCommands:
    """Small stateful model of the Companion channel-slot commands."""

    def __init__(self, slots=None):
        self.slots = dict(slots or {})
        self.next_set_result = EventType.OK
        self.set_calls: list[tuple[int, str, bytes]] = []
        self.send_calls: list[tuple[int, str]] = []

    async def get_channel(self, channel_idx: int):
        channel = self.slots.get(channel_idx)
        if channel is None:
            return _result(EventType.ERROR, {"error": "empty slot"})
        name, secret = channel
        return _result(
            EventType.CHANNEL_INFO,
            {"channel_name": name, "channel_secret": secret},
        )

    async def set_channel(self, *, channel_idx: int, channel_name: str, channel_secret: bytes):
        self.set_calls.append((channel_idx, channel_name, channel_secret))
        if self.next_set_result != EventType.OK:
            return _result(self.next_set_result, {"error": "rejected"})
        if channel_name or any(channel_secret):
            self.slots[channel_idx] = (channel_name, channel_secret)
        else:
            self.slots.pop(channel_idx, None)
        return _result(EventType.OK)

    async def send_chan_msg(self, *, chan: int, msg: str, timestamp: bytes):
        assert chan in self.slots
        assert len(timestamp) == 4
        self.send_calls.append((chan, msg))
        return _result(EventType.MSG_SENT)


class FakeChannelRadio:
    def __init__(self, slots=None):
        self.is_connected = True
        self.self_info = {"name": "MatrixNode"}
        self.commands = FakeChannelCommands(slots)


@pytest.fixture(autouse=True)
def isolated_radio_manager(monkeypatch):
    """Give every matrix case a fresh radio generation and slot cache."""
    monkeypatch.setattr(radio_manager, "_meshcore", None)
    monkeypatch.setattr(radio_manager, "_operation_lock", None)
    monkeypatch.setattr(radio_manager, "_connection_info", None)
    monkeypatch.setattr(radio_manager, "readiness_state", "ready")
    monkeypatch.setattr(radio_manager, "max_channels", 4)
    monkeypatch.setattr(radio_manager, "_channel_slot_by_key", OrderedDict())
    monkeypatch.setattr(radio_manager, "_channel_key_by_slot", {})
    monkeypatch.setattr(radio_manager, "_pending_message_channel_key_by_slot", {})


def _connect(fake: FakeChannelRadio, *, transport: str = "Serial: /dev/fake") -> None:
    radio_manager._meshcore = fake
    radio_manager._connection_info = transport
    radio_manager.readiness_state = "ready"


async def _send(key: str, text: str) -> None:
    await send_channel_message(SendChannelMessageRequest(channel_key=key, text=text))


@pytest.mark.asyncio
async def test_create_sync_readd_preserves_confirmed_fake_radio_residency(test_db):
    key = "11" * 16
    fake = FakeChannelRadio({2: ("Mesh", bytes.fromhex(key))})
    _connect(fake)

    created = await create_channel(CreateChannelRequest(name="Mesh", key=key))
    assert created.radio_residency == "database_only"

    assert await sync_channels_from_radio(fake, max_channels=4) == {"synced": 1, "cleared": 0}
    readded = await create_channel(CreateChannelRequest(name="Renamed", key=key))

    assert readded.on_radio is True
    assert readded.radio_residency == "confirmed"
    assert fake.commands.slots[2] == ("Mesh", bytes.fromhex(key))
    assert fake.commands.set_calls == []


@pytest.mark.asyncio
async def test_create_send_records_only_confirmed_set_channel_success(test_db):
    good_key = "22" * 16
    bad_key = "23" * 16
    fake = FakeChannelRadio()
    _connect(fake)

    await create_channel(CreateChannelRequest(name="Good", key=good_key))
    await _send(good_key, "confirmed")
    good = await ChannelRepository.get_by_key(good_key)
    assert good is not None and good.radio_residency == "confirmed"
    assert fake.commands.slots[0] == ("Good", bytes.fromhex(good_key))

    await create_channel(CreateChannelRequest(name="Bad", key=bad_key))
    fake.commands.next_set_result = EventType.ERROR
    with pytest.raises(HTTPException, match="Failed to configure channel"):
        await _send(bad_key, "rejected")

    bad = await ChannelRepository.get_by_key(bad_key)
    assert bad is not None and bad.radio_residency == "database_only"
    assert fake.commands.slots[0] == ("Good", bytes.fromhex(good_key))
    assert fake.commands.send_calls == [(0, "confirmed")]


@pytest.mark.asyncio
async def test_fake_radio_slot_eviction_updates_both_residency_claims(test_db):
    first_key = "31" * 16
    second_key = "32" * 16
    fake = FakeChannelRadio()
    _connect(fake)
    radio_manager.max_channels = 1

    await create_channel(CreateChannelRequest(name="First", key=first_key))
    await create_channel(CreateChannelRequest(name="Second", key=second_key))
    await _send(first_key, "one")
    await _send(second_key, "two")

    first = await ChannelRepository.get_by_key(first_key)
    second = await ChannelRepository.get_by_key(second_key)
    assert first is not None and first.radio_residency == "database_only"
    assert second is not None and second.radio_residency == "confirmed"
    assert fake.commands.slots == {0: ("Second", bytes.fromhex(second_key))}


@pytest.mark.asyncio
async def test_tcp_reconnect_downgrades_claim_until_fake_radio_resync(test_db):
    key = "41" * 16
    before_reconnect = FakeChannelRadio()
    _connect(before_reconnect, transport="TCP: fake:4000")

    await create_channel(CreateChannelRequest(name="TCP", key=key))
    await _send(key, "before reconnect")
    confirmed = await ChannelRepository.get_by_key(key)
    assert confirmed is not None and confirmed.radio_residency == "confirmed"

    radio_manager._reset_connected_runtime_state()
    stale = await ChannelRepository.get_by_key(key)
    assert stale is not None and stale.radio_residency == "stale"

    after_reconnect = FakeChannelRadio()
    _connect(after_reconnect, transport="TCP: fake:4000")
    await sync_channels_from_radio(after_reconnect, max_channels=1)
    reconciled = await ChannelRepository.get_by_key(key)
    assert reconciled is not None and reconciled.radio_residency == "database_only"


@pytest.mark.asyncio
async def test_external_radio_change_is_detected_then_reconciled(test_db):
    original_key = "51" * 16
    external_key = "52" * 16
    fake = FakeChannelRadio()
    _connect(fake)

    await create_channel(CreateChannelRequest(name="Original", key=original_key))
    await _send(original_key, "prime cache")

    # A second client overwrites the radio without going through MESHRIK.
    fake.commands.slots[0] = ("External", bytes.fromhex(external_key))
    assert await audit_channel_send_cache(fake) is False
    stale = await ChannelRepository.get_by_key(original_key)
    assert stale is not None and stale.radio_residency == "stale"

    await sync_channels_from_radio(fake, max_channels=1)
    original = await ChannelRepository.get_by_key(original_key)
    external = await ChannelRepository.get_by_key(external_key)
    assert original is not None and original.radio_residency == "database_only"
    assert external is not None and external.radio_residency == "confirmed"
