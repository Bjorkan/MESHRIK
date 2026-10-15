from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from meshcore import EventType

from app.services.radio_advanced_diagnostics import (
    parse_diagnostic,
    read_advanced_radio_diagnostics,
)


def test_diagnostic_values_are_strictly_typed():
    assert parse_diagnostic("cad", "> on") is True
    assert parse_diagnostic("cad", "> off") is False
    assert parse_diagnostic("agc_reset_interval", "> 20") == 20
    assert parse_diagnostic("cad", "private-key=abc") is None
    assert parse_diagnostic("agc_reset_interval", "123; erase") is None


@pytest.mark.asyncio
async def test_one_worker_command_for_diagnostic_batch():
    command = AsyncMock(
        side_effect=[
            SimpleNamespace(type=EventType.CLI_REPLY, payload={"text": "> on"}),
            SimpleNamespace(type=EventType.CLI_REPLY, payload={"text": "> off"}),
            SimpleNamespace(type=EventType.CLI_REPLY, payload={"text": "> 30"}),
        ]
    )
    mc = SimpleNamespace(commands=SimpleNamespace(run_cli_command=command))

    async def run_cb(_name, callback):
        return await callback(mc)

    runtime = SimpleNamespace(
        firmware_ver_code=14,
        require_connected=lambda: mc,
        run_radio_command=AsyncMock(side_effect=run_cb),
    )
    values = await read_advanced_radio_diagnostics(runtime=runtime)
    assert values["values"] == {"cad": True, "rx_gain": False, "agc_reset_interval": 30}
    runtime.run_radio_command.assert_awaited_once()
    assert command.await_count == 3
    runtime.firmware_ver_code = 13
    with pytest.raises(HTTPException):
        await read_advanced_radio_diagnostics(runtime=runtime)
