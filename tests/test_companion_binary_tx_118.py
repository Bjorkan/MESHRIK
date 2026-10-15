from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from meshcore import EventType

from app.services.channel_data_tx import send_binary_channel_data, validate_binary_tx


@pytest.mark.parametrize(
    "payload,type_id,path,width",
    [
        (b"A" * 164, 0xFFFF, None, 0),
        (b"", 0, None, 0),
        (b"", 0xFFFF, b"\x01\x02\x03", 1),
    ],
)
def test_rejects_invalid_tx(payload, type_id, path, width):
    with pytest.raises(HTTPException):
        validate_binary_tx(data_type=type_id, data=payload, path=path, path_hash_mode=width)


@pytest.mark.asyncio
async def test_tx_requires_consent_and_confirmed_slot():
    command = AsyncMock(return_value=SimpleNamespace(type=EventType.OK))
    mc = SimpleNamespace(commands=SimpleNamespace(send_channel_data=command))

    async def run_cb(_name, callback):
        return await callback(mc)

    rt = SimpleNamespace(
        require_connected=lambda: mc,
        get_confirmed_channel_slot=lambda key: 4,
        run_radio_command=AsyncMock(side_effect=run_cb),
    )
    kwargs = {
        "key": "A" * 32,
        "data_type": 0xFF00,
        "data": b"A",
        "path": None,
        "path_hash_mode": 0,
        "runtime": rt,
    }
    with pytest.raises(HTTPException) as exc:
        await send_binary_channel_data(consent=False, **kwargs)
    assert exc.value.status_code == 403
    assert await send_binary_channel_data(consent=True, **kwargs) == "accepted_by_radio"
    command.assert_awaited_once_with(4, 0xFF00, b"A", path=None, path_hash_mode=0)
