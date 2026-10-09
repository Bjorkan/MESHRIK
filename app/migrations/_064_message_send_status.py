"""Persist the outcome of outgoing radio send commands."""

import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    table_cursor = await conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
    )
    if await table_cursor.fetchone() is None:
        await conn.commit()
        return

    cursor = await conn.execute("PRAGMA table_info(messages)")
    columns = {row[1] for row in await cursor.fetchall()}
    if "send_status" not in columns:
        await conn.execute(
            "ALTER TABLE messages ADD COLUMN send_status TEXT NOT NULL DEFAULT 'confirmed'"
        )
    await conn.commit()
