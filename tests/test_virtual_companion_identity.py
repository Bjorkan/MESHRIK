"""S04 identity, handshake and generation-fencing tests."""

import asyncio
import inspect
import json
import struct
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.fanout.virtual_companion_tcp import VirtualCompanionTcpModule
from app.services.virtual_companion.identity import (
    CompanionIdentitySnapshot,
    IdentityUnavailable,
    build_identity_dispatcher,
    encode_device_info,
    encode_self_info,
    get_identity_snapshot,
)
from app.services.virtual_companion.server import VirtualCompanionServer
from app.services.virtual_companion.session import SessionState

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads(
    (ROOT / "tests/fixtures/virtual_companion_protocol_s01.json").read_text(encoding="utf-8")
)
BY_NAME = {sample["name"]: sample for sample in FIXTURES["examples"]}


def identity(generation=7):
    return CompanionIdentitySnapshot(
        generation=generation,
        protocol_version=14,
        public_key=bytes([0x22]) * 32,
        name="Synthetic Node",
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
        frequency_mhz=915.0,
        bandwidth_khz=250.0,
        spreading_factor=11,
        coding_rate=5,
        max_contacts=50,
        max_channels=10,
        firmware_build="15 Oct 2026",
        device_model="Synthetic Board",
        firmware_version="v1.18.0",
        repeat_enabled=False,
        path_hash_mode=1,
    )


async def read_wire_frame(reader):
    header = await asyncio.wait_for(reader.readexactly(3), timeout=1)
    assert header[:1] == b">"
    return await reader.readexactly(struct.unpack_from("<H", header, 1)[0])


async def connect(server):
    port = server.sockets[0].getsockname()[1]
    return await asyncio.open_connection("127.0.0.1", port)


def test_handshake_encoders_match_s01_golden_bytes_exactly():
    snapshot = identity()
    assert encode_self_info(snapshot).hex() == BY_NAME["self_info"]["payload_hex"]
    assert encode_device_info(snapshot).hex() == BY_NAME["device_info"]["payload_hex"]
    assert encode_device_info(snapshot)[4:8] == bytes(4)  # physical PIN is never exposed


@pytest.mark.asyncio
async def test_two_tcp_clients_receive_the_same_existing_identity():
    snapshot = identity()
    server = VirtualCompanionServer(build_identity_dispatcher(lambda: snapshot))
    await server.start("127.0.0.1", 0)
    reader_a, writer_a = await connect(server)
    reader_b, writer_b = await connect(server)
    try:
        request = b"<\x02\x00\x16\x0e<\x08\x00\x01\x00\x00\x00\x00\x00\x00\x00"
        writer_a.write(request)
        writer_b.write(request)
        await asyncio.gather(writer_a.drain(), writer_b.drain())
        responses_a = [await read_wire_frame(reader_a), await read_wire_frame(reader_a)]
        responses_b = [await read_wire_frame(reader_b), await read_wire_frame(reader_b)]
        assert (
            responses_a
            == responses_b
            == [
                encode_device_info(snapshot),
                encode_self_info(snapshot),
            ]
        )
        assert responses_a[1][4:36] == snapshot.public_key
    finally:
        writer_a.close()
        writer_b.close()
        await asyncio.gather(writer_a.wait_closed(), writer_b.wait_closed())
        await server.stop()


@pytest.mark.asyncio
async def test_absent_or_changed_identity_fails_closed_without_stale_replay():
    current = identity(generation=1)

    def provider():
        return current

    dispatcher = build_identity_dispatcher(provider)
    context = SessionState()
    assert await dispatcher.dispatch(b"\x16\x0e", context) == encode_device_info(current)
    assert context.identity_generation == 1
    current = replace(current, generation=2, public_key=bytes([0x44]) * 32)
    assert await dispatcher.dispatch(b"\x01" + bytes(7), context) == b"\x01\x04"

    def unavailable():
        raise IdentityUnavailable("not ready")

    unavailable_dispatcher = build_identity_dispatcher(unavailable)
    empty_context = SessionState()
    assert await unavailable_dispatcher.dispatch(b"\x16\x0e", empty_context) == b"\x01\x04"
    assert await unavailable_dispatcher.dispatch(b"\x01" + bytes(7), empty_context) == b"\x01\x04"


def test_runtime_snapshot_reads_only_complete_current_cached_state():
    self_info = {
        "public_key": "22" * 32,
        "name": "Managed Node",
        "adv_type": 1,
        "tx_power": 17,
        "max_tx_power": 22,
        "adv_lat": 57.7,
        "adv_lon": 11.9,
        "multi_acks": 1,
        "adv_loc_policy": 1,
        "telemetry_mode_base": 2,
        "telemetry_mode_loc": 1,
        "telemetry_mode_env": 0,
        "manual_add_contacts": True,
        "radio_freq": 869.525,
        "radio_bw": 250.0,
        "radio_sf": 10,
        "radio_cr": 5,
    }
    runtime = SimpleNamespace(
        radio_generation=12,
        is_connected=True,
        device_info_loaded=True,
        meshcore=SimpleNamespace(self_info=self_info),
        firmware_ver_code=15,
        max_contacts=350,
        max_channels=40,
        firmware_build="build",
        device_model="model",
        firmware_version="version",
        repeat_enabled=True,
        path_hash_mode=2,
        path_hash_mode_supported=True,
    )
    snapshot = get_identity_snapshot(runtime)
    assert snapshot.generation == 12
    assert snapshot.protocol_version == 14  # virtual surface is capped, not client-controlled
    assert snapshot.public_key == bytes([0x22]) * 32
    assert snapshot.name == "Managed Node"

    runtime.is_connected = False
    with pytest.raises(IdentityUnavailable):
        get_identity_snapshot(runtime)
    runtime.is_connected = True
    runtime.device_info_loaded = False
    with pytest.raises(IdentityUnavailable):
        get_identity_snapshot(runtime)

    source = inspect.getsource(get_identity_snapshot)
    assert ".commands" not in source
    assert "private" not in source.lower()


@pytest.mark.asyncio
async def test_generation_watch_disconnects_existing_clients_but_keeps_listener():
    generation = 10

    def read_generation():
        return generation

    module = VirtualCompanionTcpModule(
        "test",
        {
            "bind_host": "127.0.0.1",
            "port": 0,
            "unsafe_network_acknowledged": False,
            "secure_access": "",
        },
    )
    with (
        patch("app.fanout.base._broadcast_fanout_health"),
        patch(
            "app.fanout.virtual_companion_tcp.get_runtime_generation",
            side_effect=read_generation,
        ),
        patch("app.fanout.virtual_companion_tcp.GENERATION_POLL_SECONDS", 0.01),
    ):
        await module.start()
        reader, writer = await connect(module._server)
        for _ in range(20):
            if module._server.client_count == 1:
                break
            await asyncio.sleep(0.01)
        generation = 11
        assert await asyncio.wait_for(reader.read(), timeout=1) == b""
        for _ in range(20):
            if module._server.client_count == 0:
                break
            await asyncio.sleep(0.01)
        assert module._server.listening
        assert module._server.client_count == 0
        await module.stop()
        writer.close()
        await writer.wait_closed()


@pytest.mark.asyncio
async def test_privileged_commands_stay_default_denied():
    dispatcher = build_identity_dispatcher(lambda: identity())
    context = SessionState()
    for command in (0x17, 0x18, 0x21, 0x22, 0x23, 0x33, 0x41, 0x42):
        assert await dispatcher.dispatch(bytes((command,)), context) == b"\x01\x01"
