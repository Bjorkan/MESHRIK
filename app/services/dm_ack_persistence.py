"""Crash-recoverable ACK correlation tied to the connected Companion identity.

This is a best-effort durability aid over the in-memory ``dm_ack_tracker``:
ACK application stays correct without it, so every operation degrades to a
no-op when the database is unavailable instead of breaking the ACK path.
"""

import logging
import time

from app.database import db
from app.keystore import get_public_key

logger = logging.getLogger(__name__)


def own_radio_key() -> str | None:
    key = get_public_key()
    return key.hex() if isinstance(key, bytes) and len(key) == 32 else None


def _db_connected() -> bool:
    return getattr(db, "_connection", None) is not None


async def remember(code: str, message_id: int, timeout_ms: int) -> None:
    identity = own_radio_key()
    if not identity:
        return  # Never persist an unbound ACK claim for the next radio owner.
    if not _db_connected():
        return
    expiry = int(time.time() + max(30, timeout_ms / 1000 * 2))
    try:
        async with db.tx() as conn:
            await conn.execute(
                "INSERT OR REPLACE INTO pending_dm_ack_correlations "
                "(code,message_id,radio_key,expiry_at) VALUES (?,?,?,?)",
                (code, message_id, identity, expiry),
            )
            await conn.execute(
                "DELETE FROM pending_dm_ack_correlations WHERE expiry_at < ?",
                (int(time.time()),),
            )
    except Exception:
        logger.warning("Failed to persist ACK correlation %s", code, exc_info=True)


async def lookup(code: str) -> int | None:
    identity = own_radio_key()
    if not identity or not _db_connected():
        return None
    try:
        async with db.readonly() as conn:
            async with conn.execute(
                "SELECT message_id FROM pending_dm_ack_correlations WHERE code=? AND radio_key=? AND expiry_at>=?",
                (code, identity, int(time.time())),
            ) as cursor:
                row = await cursor.fetchone()
    except Exception:
        logger.warning("Failed to look up ACK correlation %s", code, exc_info=True)
        return None
    return row["message_id"] if row is not None else None


async def retire(message_id: int) -> None:
    if not _db_connected():
        return
    try:
        async with db.tx() as conn:
            await conn.execute(
                "DELETE FROM pending_dm_ack_correlations WHERE message_id=?",
                (message_id,),
            )
    except Exception:
        logger.warning(
            "Failed to retire ACK correlations for message %s", message_id, exc_info=True
        )


async def confirm(code: str, fallback_message_id: int | None = None) -> tuple[int, int] | None:
    """Atomically ACK one outgoing DM and retire all sibling correlations.

    The operation remains retryable if SQLite fails or the task is cancelled
    before COMMIT. A repeated ACK cannot increment the same row twice.
    """
    if not _db_connected():
        return None
    identity = own_radio_key()
    try:
        async with db.tx() as conn:
            found_id = None
            if identity:
                async with conn.execute(
                    "SELECT message_id FROM pending_dm_ack_correlations "
                    "WHERE code=? AND radio_key=? AND expiry_at>=?",
                    (code, identity, int(time.time())),
                ) as cursor:
                    row = await cursor.fetchone()
                    if row is not None:
                        found_id = row["message_id"]
            if found_id is None:
                found_id = fallback_message_id
            if found_id is None:
                return None
            async with conn.execute(
                "UPDATE messages SET acked=acked+1 WHERE id=? AND type='PRIV' "
                "AND outgoing=1 AND acked=0",
                (found_id,),
            ) as cursor:
                changed = cursor.rowcount
            if changed == 0:
                # Already confirmed (or not an outgoing DM); a replay must not
                # broadcast a second confirmation for the same message.
                return None
            async with conn.execute("SELECT acked FROM messages WHERE id=?", (found_id,)) as cursor:
                row = await cursor.fetchone()
            if row is None:
                return None
            await conn.execute(
                "DELETE FROM pending_dm_ack_correlations WHERE message_id=?", (found_id,)
            )
            return found_id, row["acked"]
    except Exception:
        logger.warning("Failed to confirm ACK correlation %s", code, exc_info=True)
        return None
