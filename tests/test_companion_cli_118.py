"""Deterministic contract checks for the local protocol-14 CLI adapter."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from meshcore import EventType

from app.services.companion_cli import SAFE_LOCAL_COMMANDS, run_safe_local_cli


def fake_runtime(*, version=14, text="> on"):
    commands = SimpleNamespace(
        run_cli_command=AsyncMock(
            return_value=SimpleNamespace(type=EventType.CLI_REPLY, payload={"text": text})
        )
    )
    mc = SimpleNamespace(commands=commands)

    async def run_cb(_name, callback):
        return await callback(mc)

    runtime = SimpleNamespace(
        firmware_ver_code=version,
        require_connected=lambda: mc,
        run_radio_command=AsyncMock(side_effect=run_cb),
    )
    return runtime, commands


@pytest.mark.asyncio
async def test_local_cli_worker_owns_one_command():
    runtime, commands = fake_runtime()
    assert await run_safe_local_cli("get cad", runtime=runtime) == "on"
    runtime.run_radio_command.assert_awaited_once()
    commands.run_cli_command.assert_awaited_once_with("get cad")


@pytest.mark.asyncio
async def test_local_cli_version_and_permission_gate():
    runtime, commands = fake_runtime(version=13)
    with pytest.raises(HTTPException) as exc:
        await run_safe_local_cli("get cad", runtime=runtime)
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        await run_safe_local_cli("get wifi.pwd", runtime=runtime)
    assert exc.value.status_code == 403
    commands.run_cli_command.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_cli_invalid_response_is_private():
    runtime, _ = fake_runtime(text="password\nsecret")
    with pytest.raises(HTTPException) as exc:
        await run_safe_local_cli("get radio", runtime=runtime)
    assert "secret" not in str(exc.value.detail)
    assert set(SAFE_LOCAL_COMMANDS) == {
        "get radio",
        "get cad",
        "get radio.rxgain",
        "get agc.reset.interval",
    }
