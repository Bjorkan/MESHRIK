"""Durable quarantine for opaque Companion group channel datagrams.

Firmware only provides the slot index for queued datagrams. A reused slot can
represent another channel, so these records never become chat without separate
proof of the channel identity. This is intentionally not an executable API.
"""

import hashlib
import time

from app.database import db

MAX_DATAGRAM_BYTES = 163
MAX_DATAGRAM_ROWS = 4096


def decode_channel_datagram(payload: dict) -> dict | None:
    try:
        raw = payload["payload"]
        channel_idx = payload["channel_idx"]
        data_type = payload["data_type"]
        snr = payload.get("SNR")
        path_len = payload.get("path_len")
        if not isinstance(raw, str) or len(raw) % 2 or len(raw) > 2 * MAX_DATAGRAM_BYTES:
            return None
        data = bytes.fromhex(raw)
        if (
            not isinstance(channel_idx, int)
            or isinstance(channel_idx, bool)
            or channel_idx not in range(256)
            or not isinstance(data_type, int)
            or isinstance(data_type, bool)
            or data_type not in range(1, 65536)
            or (snr is not None and (not isinstance(snr, (float, int)) or isinstance(snr, bool)))
            or (
                path_len is not None
                and (not isinstance(path_len, int) or path_len not in range(256))
            )
        ):
            return None
    except (KeyError, TypeError, ValueError):
        return None
    digest = hashlib.sha256(bytes([channel_idx]) + data_type.to_bytes(2, "little") + data).digest()
    return {
        "channel_idx": channel_idx,
        "data_type": data_type,
        "data": data,
        "snr": snr,
        "path_len": path_len,
        "identity_hash": digest,
    }


async def stage_channel_datagram(payload: dict) -> bool:
    """Stage one valid opaque frame; duplicate SDK callbacks are idempotent."""
    decoded = decode_channel_datagram(payload)
    if decoded is None:
        return False
    async with db.tx() as conn:
        async with conn.execute(
            """INSERT OR IGNORE INTO companion_channel_datagrams
               (received_at, channel_idx, data_type, payload, snr, path_len, identity_hash)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                int(time.time()),
                decoded["channel_idx"],
                decoded["data_type"],
                decoded["data"],
                decoded["snr"],
                decoded["path_len"],
                decoded["identity_hash"],
            ),
        ) as cursor:
            inserted = cursor.rowcount == 1
        # Explicit capped retention; oldest opaque records are removed only
        # after staging, never reinterpreted as messages for another channel.
        await conn.execute(
            """DELETE FROM companion_channel_datagrams
               WHERE id NOT IN (SELECT id FROM companion_channel_datagrams
                                ORDER BY id DESC LIMIT ?)""",
            (MAX_DATAGRAM_ROWS,),
        )
    return inserted
