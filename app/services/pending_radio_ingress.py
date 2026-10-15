"""Durable host-side quarantine of Companion-queued plaintext.

The firmware does not expose transactional peek/ack: ``get_msg`` already
consumes the radio item. This table makes host processing retryable, but cannot
recover frames evicted from firmware before the transport connected.
Payloads are sensitive: no body is included in diagnostics or logs.
"""

import json
import time
from typing import Any

from app.repository import messages as messages_repo

MAX_PENDING_INGRESS = 2000


def _serialize(value: Any) -> str:
    def safe(item: Any) -> dict[str, str]:
        if isinstance(item, bytes):
            return {"__bytes_hex__": item.hex()}
        raise TypeError(f"Unsupported payload field: {type(item).__name__}")

    return json.dumps(value, default=safe, separators=(",", ":"))


def _decode(value: str) -> dict:
    def restore(obj: dict) -> Any:
        if set(obj) == {"__bytes_hex__"}:
            return bytes.fromhex(obj["__bytes_hex__"])
        return obj

    result = json.loads(value, object_hook=restore)
    if not isinstance(result, dict):
        raise ValueError("Invalid queued payload envelope")
    return result


async def stage(kind: str, payload: dict) -> int:
    """Durably admit one dequeued event; do not silently evict failed messages."""
    if kind not in ("CHAN", "PRIV"):
        raise ValueError("Unsupported pending event type")
    encoded = _serialize(payload)
    if len(encoded) > 32_768:
        raise ValueError("Pending event exceeds safe journal bound")
    async with messages_repo.db.tx() as conn:
        async with conn.execute(
            "SELECT COUNT(*) AS count FROM pending_radio_ingress WHERE status != 'stored'"
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            raise RuntimeError("Queued ingress quarantine unavailable")
        if row["count"] >= MAX_PENDING_INGRESS:
            raise RuntimeError("Queued ingress quarantine full; operator action required")
        async with conn.execute(
            "INSERT INTO pending_radio_ingress (kind,payload,created_at) VALUES (?,?,?)",
            (kind, encoded, int(time.time())),
        ) as cursor:
            entry_id = cursor.lastrowid
        if entry_id is None:
            raise RuntimeError("Queued ingress journal insert failed")
        return entry_id


async def settle(entry_id: int, *, stored: bool, reason: str = "") -> None:
    """State transition committed only after the chat writer returned."""
    async with messages_repo.db.tx() as conn:
        await conn.execute(
            "UPDATE pending_radio_ingress SET status=?,attempts=attempts+1,last_error=? WHERE id=?",
            ("stored" if stored else "unresolved", reason[:80] if reason else None, entry_id),
        )


async def unresolved(limit: int = 100) -> list[tuple[int, str, dict]]:
    async with messages_repo.db.readonly() as conn:
        async with conn.execute(
            "SELECT id,kind,payload FROM pending_radio_ingress "
            "WHERE status='unresolved' ORDER BY id LIMIT ?",
            (min(100, limit),),
        ) as cursor:
            rows = await cursor.fetchall()
    return [(row["id"], row["kind"], _decode(row["payload"])) for row in rows]


async def counters() -> dict[str, int]:
    async with messages_repo.db.readonly() as conn:
        async with conn.execute(
            "SELECT status, COUNT(*) AS count FROM pending_radio_ingress GROUP BY status"
        ) as cursor:
            rows = await cursor.fetchall()
    return {row["status"]: row["count"] for row in rows}
