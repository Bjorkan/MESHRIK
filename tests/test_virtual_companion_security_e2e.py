"""S12 release-gate proofs for the complete virtual Companion stack.

These tests intentionally cross the TCP boundary.  They use synthetic identities
and loopback sockets only; no physical radio, real peer address, or secret is a
fixture.
"""

import asyncio
import logging
import struct
from contextlib import AsyncExitStack
from unittest.mock import AsyncMock, patch

import pytest
from meshcore import MeshCore

from app.fanout.virtual_companion_tcp import VirtualCompanionTcpModule
from app.services.virtual_companion.identity import CompanionIdentitySnapshot
from app.services.virtual_companion.server import VirtualCompanionServer
from app.services.virtual_companion.session import VirtualCompanionSession


def _identity(*, generation: int = 1, protocol_version: int = 14):
    return CompanionIdentitySnapshot(
        generation=generation,
        protocol_version=protocol_version,
        public_key=bytes.fromhex("22" * 32),
        name="Synthetic S12 Node",
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
        firmware_build="synthetic",
        device_model="CI fixture",
        firmware_version="protocol test",
        repeat_enabled=False,
        path_hash_mode=0,
    )


def _config(**changes):
    return {
        "bind_host": "127.0.0.1",
        "port": 0,
        "unsafe_network_acknowledged": False,
        "secure_access": "",
        "virtual_channel_capacity": 4,
        "channel_slots": [],
        **changes,
    }


async def _read_frame(reader: asyncio.StreamReader) -> bytes:
    header = await asyncio.wait_for(reader.readexactly(3), timeout=2)
    assert header[:1] == b">"
    size = struct.unpack_from("<H", header, 1)[0]
    assert 1 <= size <= 176
    return await asyncio.wait_for(reader.readexactly(size), timeout=2)


async def _wait_for_clients(server: VirtualCompanionServer, expected: int) -> None:
    for _ in range(100):
        if server.client_count == expected:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"expected {expected} clients, got {server.client_count}")


@pytest.mark.asyncio
async def test_released_meshcore_py_tcp_client_keeps_two_sessions_on_one_identity():
    """Exercise the pinned production SDK, not a test-only frame decoder."""
    module = VirtualCompanionTcpModule("s12", _config(), name="Synthetic Companion")
    with (
        patch("app.fanout.base._broadcast_fanout_health"),
        patch("app.fanout.virtual_companion_tcp.get_identity_snapshot", return_value=_identity()),
    ):
        await module.start()
        port = module._server.sockets[0].getsockname()[1]
        clients = await asyncio.gather(
            MeshCore.create_tcp("127.0.0.1", port, default_timeout=2),
            MeshCore.create_tcp("127.0.0.1", port, default_timeout=2),
        )
        try:
            assert all(client is not None for client in clients)
            assert [client.self_info["public_key"] for client in clients if client] == [
                "22" * 32,
                "22" * 32,
            ]
            await _wait_for_clients(module._server, 2)
            assert len(module.status_details["client_sessions"]) == 2
        finally:
            await asyncio.gather(*(client.disconnect() for client in clients if client))
            await module.stop()


@pytest.mark.asyncio
async def test_eight_clients_negotiate_independently_and_reconnect_without_state_reuse():
    module = VirtualCompanionTcpModule("s12", _config(), name="Synthetic Companion")
    with (
        patch("app.fanout.base._broadcast_fanout_health"),
        patch("app.fanout.virtual_companion_tcp.get_identity_snapshot", return_value=_identity()),
    ):
        await module.start()
        port = module._server.sockets[0].getsockname()[1]
        peers = [await asyncio.open_connection("127.0.0.1", port) for _ in range(8)]
        try:
            for index, (_reader, writer) in enumerate(peers):
                writer.write(b"<\x02\x00\x16" + bytes((13 + index % 2,)))
            await asyncio.gather(*(writer.drain() for _reader, writer in peers))
            responses = await asyncio.gather(*(_read_frame(reader) for reader, _writer in peers))
            assert all(response[0] == 0x0D for response in responses)
            await _wait_for_clients(module._server, 8)
            assert [row["protocol_version"] for row in module._server.client_statuses] == [
                13,
                14,
                13,
                14,
                13,
                14,
                13,
                14,
            ]

            for _reader, writer in peers[:3]:
                writer.close()
            await asyncio.gather(*(writer.wait_closed() for _reader, writer in peers[:3]))
            await _wait_for_clients(module._server, 5)
            replacements = [await asyncio.open_connection("127.0.0.1", port) for _ in range(3)]
            peers.extend(replacements)
            for _reader, writer in replacements:
                writer.write(b"<\x02\x00\x16\x0e")
            await asyncio.gather(*(writer.drain() for _reader, writer in replacements))
            responses = await asyncio.gather(
                *(_read_frame(reader) for reader, _writer in replacements)
            )
            assert all(response[0] == 0x0D for response in responses)
            await _wait_for_clients(module._server, 8)
            assert [row["session_id"] for row in module._server.client_statuses] == [
                "session-4",
                "session-5",
                "session-6",
                "session-7",
                "session-8",
                "session-9",
                "session-10",
                "session-11",
            ]
        finally:
            for _reader, writer in peers:
                writer.close()
            await asyncio.gather(
                *(writer.wait_closed() for _reader, writer in peers), return_exceptions=True
            )
            await module.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol_version", [13, 14])
async def test_every_command_byte_over_tcp_is_bounded_and_cannot_open_physical_transport(
    test_db, protocol_version
):
    """Fuzz the complete command byte space behind physical-access tripwires."""
    module = VirtualCompanionTcpModule("s12", _config(), name="Synthetic Companion")

    def forbidden(*_args, **_kwargs):
        raise AssertionError("virtual read/deny path attempted physical access")

    with (
        patch("app.fanout.base._broadcast_fanout_health"),
        patch(
            "app.fanout.virtual_companion_tcp.get_identity_snapshot",
            return_value=_identity(protocol_version=protocol_version),
        ),
        patch("app.services.radio_runtime.radio_runtime.require_connected", side_effect=forbidden),
        patch("meshcore.BLEConnection.connect", side_effect=forbidden),
        patch("meshcore.SerialConnection.connect", side_effect=forbidden),
        patch("meshcore.TCPConnection.connect", side_effect=forbidden),
        patch(
            "meshcore.commands.base.CommandHandlerBase.send",
            new_callable=AsyncMock,
            side_effect=forbidden,
        ),
    ):
        await module.start()
        port = module._server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            # Negotiate exactly the two supported source-derived protocol versions.
            writer.write(b"<\x02\x00\x16" + bytes((protocol_version,)))
            await writer.drain()
            device = await _read_frame(reader)
            assert device[:2] == bytes((0x0D, protocol_version))

            for command in range(256):
                writer.write(b"<\x01\x00" + bytes((command,)))
                await writer.drain()
                response = await _read_frame(reader)
                assert 1 <= len(response) <= 176
        finally:
            writer.close()
            await writer.wait_closed()
            await module.stop()


@pytest.mark.asyncio
async def test_malformed_peers_are_evicted_without_harming_a_healthy_client():
    module = VirtualCompanionTcpModule("s12", _config(), name="Synthetic Companion")
    with (
        patch("app.fanout.base._broadcast_fanout_health"),
        patch("app.fanout.virtual_companion_tcp.get_identity_snapshot", return_value=_identity()),
    ):
        await module.start()
        port = module._server.sockets[0].getsockname()[1]
        healthy_reader, healthy_writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            malformed = (
                b">\x01\x00\x05",  # wrong direction
                b"<\x00\x00",  # empty payload
                b"<\xb1\x00",  # larger than the firmware frame bound
                b"<\x02\x00\x16",  # truncated payload
            )
            async with AsyncExitStack() as stack:
                peers = []
                for wire in malformed:
                    reader, writer = await asyncio.open_connection("127.0.0.1", port)
                    peers.append((reader, writer))
                    writer.write(wire)
                    await writer.drain()
                    writer.write_eof()
                    stack.callback(writer.close)
                assert await asyncio.gather(
                    *(asyncio.wait_for(reader.read(), timeout=2) for reader, _writer in peers)
                ) == [b""] * len(peers)

            healthy_writer.write(b"<\x02\x00\x16\x0e")
            await healthy_writer.drain()
            assert (await _read_frame(healthy_reader))[:2] == b"\x0d\x0e"
        finally:
            healthy_writer.close()
            await healthy_writer.wait_closed()
            await module.stop()


class _SlowWriter:
    def write(self, _data):
        return None

    async def drain(self):
        await asyncio.Future()

    def close(self):
        return None

    async def wait_closed(self):
        return None


@pytest.mark.asyncio
async def test_twenty_slow_clients_coalesce_a_ten_thousand_message_burst():
    """A burst is constant-space per client and never blocks inbound DB work."""
    server = VirtualCompanionServer(object())
    sessions = {
        VirtualCompanionSession(None, _SlowWriter(), object(), outbox_size=2) for _ in range(20)
    }
    server._sessions.update(sessions)

    for message_id in range(1, 10_001):
        server.notify_message_waiting(message_id)

    assert server.client_count == 20
    assert {session._outbox.qsize() for session in sessions} == {1}
    assert {await session._next_outbound() for session in sessions} == {b"\x83"}


@pytest.mark.asyncio
async def test_listener_restart_soak_and_port_collision_leave_no_orphan_socket():
    for _ in range(12):
        module = VirtualCompanionTcpModule("s12", _config(), name="Synthetic Companion")
        with patch("app.fanout.base._broadcast_fanout_health"):
            await module.start()
            port = module._server.sockets[0].getsockname()[1]
            blocker = VirtualCompanionTcpModule("collision", _config(port=port), name="Collision")
            with pytest.raises(OSError):
                await blocker.start()
            assert blocker.status == "error"
            await module.stop()
            assert not module._server.listening


@pytest.mark.asyncio
async def test_denied_payload_is_not_reflected_into_logs(caplog):
    marker = "S12_PRIVATE_FIXTURE_MUST_NOT_LEAK"
    module = VirtualCompanionTcpModule("s12", _config(), name="Synthetic Companion")
    with (
        patch("app.fanout.base._broadcast_fanout_health"),
        patch("app.fanout.virtual_companion_tcp.get_identity_snapshot", return_value=_identity()),
        caplog.at_level(logging.DEBUG),
    ):
        await module.start()
        port = module._server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        try:
            payload = b"\x42" + marker.encode()
            writer.write(b"<" + len(payload).to_bytes(2, "little") + payload)
            await writer.drain()
            assert await _read_frame(reader) == b"\x01\x01"
        finally:
            writer.close()
            await writer.wait_closed()
            await module.stop()
    assert marker not in caplog.text
