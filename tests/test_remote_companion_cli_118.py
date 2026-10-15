from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from meshcore import EventType

from app.services.remote_companion_cli import remote_read_command


@pytest.mark.asyncio
async def test_remote_companion_cli_explicit_consent_and_chat_type():
    send = AsyncMock(return_value=SimpleNamespace(type=EventType.MSG_SENT))
    mc = SimpleNamespace(commands=SimpleNamespace(send_cmd=send))

    async def run_cb(_name, callback):
        return await callback(mc)

    runtime = SimpleNamespace(
        firmware_ver_code=14,
        require_connected=lambda: mc,
        run_radio_command=AsyncMock(side_effect=run_cb),
    )
    contact = SimpleNamespace(type=1, on_radio=True)
    with patch(
        "app.services.remote_companion_cli.ContactRepository.get_by_key",
        new=AsyncMock(return_value=contact),
    ):
        with pytest.raises(HTTPException) as exc:
            await remote_read_command(
                public_key="ab" * 32, command="set radio 1", consent=True, runtime=runtime
            )
        assert exc.value.status_code == 403
        result = await remote_read_command(
            public_key="ab" * 32, command="get radio", consent=True, runtime=runtime
        )
    assert result["status"] == "radio_accepted_remote_execution_unconfirmed"
    send.assert_awaited_once_with("ab" * 32, "get radio", dst_type=1)
