"""Device-signed JWT identity on stock Companion without exporting secrets."""

from __future__ import annotations

import base64
import json
from types import SimpleNamespace
from unittest.mock import patch

import nacl.signing
import pytest
from meshcore.events import Event, EventType

from app.fanout.community_mqtt import _sign_jwt_on_connected_radio
from app.keystore import clear_keys, get_private_key, get_public_key, set_public_key_from_radio


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
