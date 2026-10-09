"""Add a message-ID tie-breaker to read-state timestamps."""

import aiosqlite


async def _add_cursor(
    conn: aiosqlite.Connection,
    *,
    table: str,
    key_column: str,
    message_type: str,
) -> None:
    table_cursor = await conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    )
    if await table_cursor.fetchone() is None:
        return

    column_cursor = await conn.execute(f"PRAGMA table_info({table})")
    columns = {row[1] for row in await column_cursor.fetchall()}
    added = "last_read_message_id" not in columns
    if added:
        await conn.execute(f"ALTER TABLE {table} ADD COLUMN last_read_message_id INTEGER")

    messages_cursor = await conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
    )
    if not added or "last_read_at" not in columns or await messages_cursor.fetchone() is None:
        return

    # Preserve the old timestamp-only semantics on upgrade. Messages from the
    # boundary second were previously treated as read, so seed the cursor past
    # every such row already present.
    await conn.execute(
        f"""
        UPDATE {table}
        SET last_read_message_id = COALESCE((
            SELECT MAX(m.id)
            FROM messages m
            WHERE m.type = ?
              AND m.conversation_key = {table}.{key_column}
              AND m.received_at <= {table}.last_read_at
        ), 0)
        WHERE last_read_at IS NOT NULL
        """,
        (message_type,),
    )


async def migrate(conn: aiosqlite.Connection) -> None:
    await _add_cursor(
        conn,
        table="contacts",
        key_column="public_key",
        message_type="PRIV",
    )
    await _add_cursor(
        conn,
        table="channels",
        key_column="key",
        message_type="CHAN",
    )
    await conn.commit()
