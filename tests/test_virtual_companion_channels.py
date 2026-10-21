"""S06 stable database-backed virtual channel slot tests."""

import asyncio
import inspect
from dataclasses import replace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.fanout.manager import FanoutManager
from app.fanout.virtual_companion_tcp import VirtualCompanionTcpModule
from app.repository.channels import ChannelRepository
from app.repository.fanout import FanoutConfigRepository
from app.routers.fanout import _validate_and_normalize_config
from app.services.virtual_companion.channels import (
    RESP_CODE_CHANNEL_INFO,
    VirtualCompanionChannels,
    register_channel_commands,
)
from app.services.virtual_companion.dispatch import CommandDispatcher
from app.services.virtual_companion.identity import CompanionIdentitySnapshot
from app.services.virtual_companion.session import SessionState

KEY_A = "11" * 16
KEY_B = "22" * 16
KEY_C = "33" * 16


def _config(**changes):
    value = {
        "bind_host": "127.0.0.1",
        "port": 4001,
        "unsafe_network_acknowledged": False,
        "secure_access": "",
        "virtual_channel_capacity": 3,
        "channel_slots": [KEY_A, None, KEY_B],
    }
    value.update(changes)
    return value


def _identity() -> CompanionIdentitySnapshot:
    return CompanionIdentitySnapshot(
        generation=1,
        protocol_version=14,
        public_key=bytes([0x44]) * 32,
        name="Node",
        advert_type=1,
        tx_power=14,
        max_tx_power=22,
        latitude=0,
        longitude=0,
        multi_acks=0,
        advert_location_policy=0,
        telemetry_mode_base=0,
        telemetry_mode_location=0,
        telemetry_mode_environment=0,
        manual_add_contacts=False,
        frequency_mhz=915,
        bandwidth_khz=250,
        spreading_factor=11,
        coding_rate=5,
        max_contacts=50,
        max_channels=99,
        firmware_build="build",
        device_model="model",
        firmware_version="version",
        repeat_enabled=False,
        path_hash_mode=0,
    )


@pytest.mark.asyncio
async def test_empty_one_and_full_slot_sets_have_exact_wire_layout(test_db):
    context = SessionState()
    empty = VirtualCompanionChannels((), capacity=3)
    assert await empty.get_channel(b"\x1f\x00", context) == b"\x01\x02"

    await ChannelRepository.upsert(KEY_A, "Åland")
    await ChannelRepository.upsert(KEY_B, "Bravo")
    await ChannelRepository.upsert(KEY_C, "Charlie")
    one = VirtualCompanionChannels((KEY_A,), capacity=3)
    expected = (
        bytes((RESP_CODE_CHANNEL_INFO, 0))
        + "Åland".encode().ljust(32, b"\0")
        + bytes.fromhex(KEY_A)
    )
    assert await one.get_channel(b"\x1f\x00", context) == expected
    assert len(expected) == 50
    assert await one.get_channel(b"\x1f\x01", context) == b"\x01\x02"

    full = VirtualCompanionChannels((KEY_A, KEY_B, KEY_C), capacity=3)
    responses = [await full.get_channel(bytes((0x1F, slot)), context) for slot in range(3)]
    assert [response[1] for response in responses] == [0, 1, 2]
    assert [response[34:] for response in responses] == [
        bytes.fromhex(KEY_A),
        bytes.fromhex(KEY_B),
        bytes.fromhex(KEY_C),
    ]


@pytest.mark.asyncio
async def test_shared_mapping_survives_updates_reconnects_and_does_not_compact(test_db):
    await ChannelRepository.upsert(KEY_A, "Alpha")
    await ChannelRepository.upsert(KEY_B, "Beta")
    adapter = VirtualCompanionChannels((KEY_A, None, KEY_B), capacity=3)
    clients = (SessionState(), SessionState())
    initial = [await adapter.get_channel(b"\x1f\x02", client) for client in clients]
    assert initial[0] == initial[1]

    await ChannelRepository.upsert(KEY_B, "Beta updated")
    reconnect = await adapter.get_channel(b"\x1f\x02", SessionState())
    assert reconnect[1] == 2
    assert reconnect[2:34].rstrip(b"\0") == b"Beta updated"

    await ChannelRepository.delete(KEY_A)
    await ChannelRepository.upsert(KEY_C, "New channel")
    assert await adapter.get_channel(b"\x1f\x00", SessionState()) == b"\x01\x02"
    assert (await adapter.get_channel(b"\x1f\x02", SessionState()))[34:] == bytes.fromhex(KEY_B)


@pytest.mark.asyncio
async def test_invalid_or_stale_slots_fail_without_physical_slot_access(test_db):
    await ChannelRepository.upsert(KEY_A, "Alpha")
    adapter = VirtualCompanionChannels((KEY_A,), capacity=1)
    dispatcher = CommandDispatcher()
    register_channel_commands(dispatcher, adapter)
    context = SessionState()
    assert await dispatcher.dispatch(b"\x1f", context) == b"\x01\x06"
    assert await dispatcher.dispatch(b"\x1f\x01", context) == b"\x01\x02"
    await ChannelRepository.delete(KEY_A)
    assert await dispatcher.dispatch(b"\x1f\x00", context) == b"\x01\x02"

    source = "\n".join(
        (
            inspect.getsource(VirtualCompanionChannels),
            inspect.getsource(ChannelRepository.get_companion_channel),
        )
    )
    assert "_channel_slot_by_key" not in source
    assert "get_channel(" not in inspect.getsource(ChannelRepository.get_companion_channel)
    assert "set_channel" not in source
    assert "run_radio_command" not in source


def test_config_normalizes_persisted_slots_and_rejects_invalid_secrets():
    normalized = _validate_and_normalize_config(
        "virtual_companion_tcp",
        {
            "virtual_channel_capacity": 3,
            "channel_slots": [KEY_A.lower(), None, KEY_B.lower()],
        },
    )
    assert normalized == _config()

    invalid = [
        {"virtual_channel_capacity": 0},
        {"virtual_channel_capacity": True},
        {"virtual_channel_capacity": 1, "channel_slots": [KEY_A, KEY_B]},
        {"channel_slots": "not-a-list"},
        {"channel_slots": ["abcd"]},
        {"channel_slots": [KEY_A, KEY_A.lower()]},
    ]
    for config in invalid:
        with pytest.raises(HTTPException) as exc_info:
            _validate_and_normalize_config("virtual_companion_tcp", config)
        assert exc_info.value.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("slots", [[], [KEY_A], [KEY_A, KEY_B, KEY_C]])
async def test_device_info_advertises_virtual_not_physical_capacity(slots):
    with patch(
        "app.fanout.virtual_companion_tcp.get_identity_snapshot",
        return_value=replace(_identity(), max_channels=99),
    ):
        module = VirtualCompanionTcpModule("test", _config(channel_slots=slots))
        response = await module._server.dispatcher.dispatch(b"\x16\x0e", SessionState())
    assert isinstance(response, bytes)
    assert response[:4] == bytes((0x0D, 14, 25, 3))
    assert module.status_details["virtual_channel_capacity"] == 3
    assert module.status_details["configured_channel_slots"] == len(slots)
    assert str(module.status_details).find(KEY_A) == -1


@pytest.mark.asyncio
async def test_persisted_remap_reload_disconnects_old_clients(test_db):
    await ChannelRepository.upsert(KEY_A, "Alpha")
    await ChannelRepository.upsert(KEY_B, "Beta")
    config = _config(port=0, channel_slots=[KEY_A, None, KEY_B])
    cfg = await FanoutConfigRepository.create(
        config_type="virtual_companion_tcp",
        name="Virtual Companion",
        config=config,
        scope={"messages": "none", "raw_packets": "none"},
        enabled=True,
    )
    manager = FanoutManager()
    with patch("app.fanout.base._broadcast_fanout_health"):
        assert await manager.reload_config(cfg["id"]) is None
    old_module = manager._modules[cfg["id"]][0]
    port = old_module._server.sockets[0].getsockname()[1]
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        updated_config = _config(port=0, channel_slots=[KEY_B, None, KEY_A])
        await FanoutConfigRepository.update(cfg["id"], config=updated_config)
        with patch("app.fanout.base._broadcast_fanout_health"):
            assert await manager.reload_config(cfg["id"]) is None
        assert await reader.read() == b""
        new_module = manager._modules[cfg["id"]][0]
        slot = await new_module._channels.resolve_slot(0)
        assert slot is not None and slot.key == KEY_B
    finally:
        writer.close()
        await writer.wait_closed()
        await manager.stop_all()
