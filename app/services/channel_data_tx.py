"""Explicitly authorized binary channel TX, never a chat-message shortcut."""

import logging

from fastapi import HTTPException
from meshcore import EventType

from app.services.radio_runtime import radio_runtime

MAX_BINARY_PAYLOAD = 163


class _RedactDatagramLog(logging.Filter):
    """Prevent meshcore-py DEBUG command dumps from disclosing payload bytes."""

    def filter(self, record: logging.LogRecord) -> bool:
        raw = record.getMessage()
        return not (
            raw.startswith("Sending raw data: 3e")
            or raw.startswith("Sending raw data ")
            and "through path" in raw
        )


_filter = _RedactDatagramLog()
_meshcore_logger = logging.getLogger("meshcore")
if not any(isinstance(f, _RedactDatagramLog) for f in _meshcore_logger.filters):
    _meshcore_logger.addFilter(_filter)


def validate_binary_tx(
    *, data_type: int, data: bytes, path: bytes | None, path_hash_mode: int
) -> None:
    # Developer-specific datagram namespace only; public/registered types need
    # a separate application contract and authorization review.
    if isinstance(data_type, bool) or not 0xFF00 <= data_type <= 0xFFFF:
        raise HTTPException(status_code=422, detail="Developer data_type must be 0xFF00–0xFFFF")
    if len(data) > MAX_BINARY_PAYLOAD:
        raise HTTPException(status_code=422, detail="Binary datagram exceeds radio limit")
    if path_hash_mode not in (0, 1, 2):
        raise HTTPException(status_code=422, detail="Invalid direct route hash width")
    if path is not None and (len(path) % (path_hash_mode + 1) or len(path) > 63):
        raise HTTPException(status_code=422, detail="Invalid direct path byte length")


async def send_binary_channel_data(
    *,
    key: str,
    data_type: int,
    data: bytes,
    path: bytes | None,
    path_hash_mode: int,
    consent: bool,
    runtime=radio_runtime,
) -> str:
    if not consent:
        raise HTTPException(status_code=403, detail="Explicit datagram RF consent is required")
    validate_binary_tx(data_type=data_type, data=data, path=path, path_hash_mode=path_hash_mode)
    runtime.require_connected()

    async def execute(mc):
        # Check against this worker's current radio-generation slot evidence;
        # never silently overwrite or add channel slots to transmit.
        slot = runtime.get_confirmed_channel_slot(key)
        if slot is None:
            raise HTTPException(status_code=409, detail="Channel not verified on connected radio")
        if not callable(getattr(mc.commands, "send_channel_data", None)):
            raise HTTPException(status_code=501, detail="SDK does not support channel datagrams")
        return await mc.commands.send_channel_data(
            slot, data_type, data, path=path, path_hash_mode=path_hash_mode
        )

    result = await runtime.run_radio_command("send_channel_datagram", execute)
    if result is None or result.type != EventType.OK:
        raise HTTPException(status_code=502, detail="Companion rejected binary datagram")
    return "accepted_by_radio"
