"""Device-signed JWT identity on stock Companion without exporting secrets."""

from __future__ import annotations

import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

import aiomqtt
import nacl.signing
import pytest
from meshcore.events import Event, EventType

from app.fanout.community_mqtt import _sign_jwt_on_connected_radio
from app.keystore import clear_keys, get_private_key, get_public_key, set_public_key_from_radio


class FakeCompanionSigningCommands:
    """Stateful fake of the Companion's global START/DATA/FINISH signing buffer."""

    def __init__(self, signing_key: nacl.signing.SigningKey):
        self.signing_key = signing_key
        self.buffer = bytearray()
        self.operations: list[tuple[str, bytes]] = []

    async def sign_start(self):
        self.buffer.clear()
        self.operations.append(("START", b""))
        return Event(EventType.OK, {})

    async def sign_data(self, data: bytes):
        self.buffer.extend(data)
        self.operations.append(("DATA", data))
        return Event(EventType.OK, {})

    async def sign_finish(self):
        self.operations.append(("FINISH", b""))
        signature = self.signing_key.sign(bytes(self.buffer)).signature
        return Event(EventType.SIGNATURE, {"signature": signature})

    async def sign(self, data: bytes, *, chunk_size: int, timeout: int):
        assert timeout == 30
        await self.sign_start()
        for offset in range(0, len(data), chunk_size):
            await self.sign_data(data[offset : offset + chunk_size])
        return await self.sign_finish()


class LocalJwtBroker:
    """Minimal MQTT 3.1.1 broker that authorizes the Companion JWT identity."""

    def __init__(self, public_key: bytes, audience: str):
        self.public_key = public_key
        self.audience = audience
        self.authorized = asyncio.Event()
        self.server: asyncio.Server | None = None
        self.port = 0

    async def __aenter__(self):
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *_exc):
        assert self.server is not None
        self.server.close()
        await self.server.wait_closed()

    @staticmethod
    async def _remaining_length(reader: asyncio.StreamReader) -> int:
        value = 0
        multiplier = 1
        while True:
            encoded = (await reader.readexactly(1))[0]
            value += (encoded & 0x7F) * multiplier
            if encoded & 0x80 == 0:
                return value
            multiplier *= 128

    @staticmethod
    def _field(data: bytes, offset: int) -> tuple[bytes, int]:
        length = int.from_bytes(data[offset : offset + 2], "big")
        start = offset + 2
        return data[start : start + length], start + length

    def _authorize(self, username: str, token: str) -> bool:
        try:
            header, payload, signature_hex = token.split(".")
            claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
            signing_input = f"{header}.{payload}".encode()
            nacl.signing.VerifyKey(self.public_key).verify(
                signing_input, bytes.fromhex(signature_hex)
            )
            expected_key = self.public_key.hex().upper()
            return (
                username == f"v1_{expected_key}"
                and claims["publicKey"] == expected_key
                and claims["owner"] == expected_key
                and claims["aud"] == self.audience
                and signature_hex == signature_hex.lower()
            )
        except (KeyError, ValueError, json.JSONDecodeError, nacl.exceptions.BadSignatureError):
            return False

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            first = await reader.readexactly(1)
            assert first[0] >> 4 == 1
            packet = await reader.readexactly(await self._remaining_length(reader))
            protocol, offset = self._field(packet, 0)
            assert protocol == b"MQTT" and packet[offset] == 4
            flags = packet[offset + 1]
            offset += 4  # protocol level, flags and keepalive
            _, offset = self._field(packet, offset)  # client identifier
            username_bytes, offset = self._field(packet, offset) if flags & 0x80 else (b"", offset)
            password_bytes, _ = self._field(packet, offset) if flags & 0x40 else (b"", offset)
            accepted = self._authorize(username_bytes.decode(), password_bytes.decode())
            writer.write(b"\x20\x02\x00" + (b"\x00" if accepted else b"\x05"))
            await writer.drain()
            if accepted:
                self.authorized.set()
            while True:
                packet_type = (await reader.readexactly(1))[0] >> 4
                remaining = await self._remaining_length(reader)
                if remaining:
                    await reader.readexactly(remaining)
                if packet_type == 14:
                    break
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()


@pytest.mark.asyncio
async def test_fake_companion_signs_exact_jwt_input_via_one_radio_job():
    signing = nacl.signing.SigningKey(bytes(range(32)))
    pubkey = signing.verify_key.encode()
    clear_keys()
    set_public_key_from_radio(pubkey.hex())
    assert get_private_key() is None and get_public_key() == pubkey
    commands = SimpleNamespace()
    received: list[bytes] = []

    async def sign(data, chunk_size, timeout):
        assert chunk_size == 120 and timeout == 30
        received.append(data)
        return Event(EventType.SIGNATURE, {"signature": signing.sign(data).signature})

    commands.sign = sign
    mc = SimpleNamespace(commands=commands)

    async def run_single_worker(name, callback, **kwargs):
        assert name == "community_jwt_sign" and kwargs == {"blocking": True}
        return await callback(mc)

    manager = SimpleNamespace(
        meshcore=mc,
        is_connected=True,
        radio_generation=77,
        run_radio_command=run_single_worker,
    )
    try:
        with patch("app.services.radio_runtime.radio_runtime", manager):
            jwt = await _sign_jwt_on_connected_radio(pubkey, audience="test-broker", email="")
        header, payload, sig = jwt.split(".")
        assert (
            json.loads(base64.urlsafe_b64decode(payload + "=="))["publicKey"]
            == pubkey.hex().upper()
        )
        assert json.loads(base64.urlsafe_b64decode(payload + "=="))["aud"] == "test-broker"
        assert json.loads(base64.urlsafe_b64decode(header + "=="))["alg"] == "Ed25519"
        signing.verify_key.verify(f"{header}.{payload}".encode(), bytes.fromhex(sig))
        assert received == [f"{header}.{payload}".encode()]
        assert get_private_key() is None
    finally:
        clear_keys()


@pytest.mark.asyncio
async def test_fake_companion_start_data_finish_jwt_is_authorized_by_local_broker():
    signing = nacl.signing.SigningKey(bytes(reversed(range(32))))
    pubkey = signing.verify_key.encode()
    commands = FakeCompanionSigningCommands(signing)
    mc = SimpleNamespace(commands=commands)

    async def run_single_worker(_name, callback, **_kwargs):
        return await callback(mc)

    manager = SimpleNamespace(
        meshcore=mc,
        is_connected=True,
        radio_generation=19,
        run_radio_command=run_single_worker,
    )
    audience = "local-test-broker"

    with patch("app.services.radio_runtime.radio_runtime", manager):
        token = await _sign_jwt_on_connected_radio(pubkey, audience=audience, email="")

    header, payload, _signature = token.split(".")
    exact_signing_input = f"{header}.{payload}".encode()
    operation_names = [operation for operation, _ in commands.operations]
    assert operation_names[0] == "START"
    assert operation_names[-1] == "FINISH"
    assert len(operation_names) > 3
    assert set(operation_names[1:-1]) == {"DATA"}
    assert b"".join(data for operation, data in commands.operations if operation == "DATA") == (
        exact_signing_input
    )

    async with LocalJwtBroker(pubkey, audience) as broker:
        async with aiomqtt.Client(
            hostname="127.0.0.1",
            port=broker.port,
            identifier="meshrik-signing-test",
            username=f"v1_{pubkey.hex().upper()}",
            password=token,
            protocol=aiomqtt.ProtocolVersion.V311,
        ):
            await asyncio.wait_for(broker.authorized.wait(), timeout=2)


@pytest.mark.asyncio
async def test_reconnect_fence_and_wrong_identity_discard_signatures():
    signing = nacl.signing.SigningKey(bytes(range(32)))
    pubkey = signing.verify_key.encode()
    mc = SimpleNamespace(commands=SimpleNamespace())
    manager = SimpleNamespace(meshcore=mc, is_connected=True, radio_generation=4)

    async def produce(data, chunk_size, timeout):
        return Event(EventType.SIGNATURE, {"signature": signing.sign(data).signature})

    mc.commands.sign = produce

    async def reconnect_during_worker(_name, callback, **_kwargs):
        result = await callback(mc)
        manager.radio_generation += 1
        return result

    manager.run_radio_command = reconnect_during_worker
    with patch("app.services.radio_runtime.radio_runtime", manager):
        with pytest.raises(RuntimeError, match="reconnected"):
            await _sign_jwt_on_connected_radio(pubkey, audience="test", email="")

    async def wrong_identity(_name, callback, **_kwargs):
        return Event(EventType.SIGNATURE, {"signature": b"x" * 64}).payload["signature"]

    manager.run_radio_command = wrong_identity
    with patch("app.services.radio_runtime.radio_runtime", manager):
        with pytest.raises(RuntimeError, match="does not match"):
            await _sign_jwt_on_connected_radio(pubkey, audience="test", email="")


def test_radio_identity_validated_even_without_private_export():
    clear_keys()
    with pytest.raises(ValueError):
        set_public_key_from_radio("ab")
    with pytest.raises(ValueError):
        set_public_key_from_radio("XX" * 32)
    set_public_key_from_radio("D1" * 32)
    assert get_public_key() == bytes.fromhex("D1" * 32)
    assert get_private_key() is None
    clear_keys()
