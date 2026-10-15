"""Replace forever-unique text/second indexes with packet-aware identity."""

import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    # Guard: migration tests create partial schemas; only run when messages exists.
    cur = await conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
    )
    if not await cur.fetchone():
        return
    cur = await conn.execute("PRAGMA table_info(messages)")
    columns = {row[1] for row in await cur.fetchall()}
    if "wire_packet_id" not in columns:
        await conn.execute("ALTER TABLE messages ADD COLUMN wire_packet_id INTEGER")
    # Preserve historical rows verbatim; no missing RF identities can be recovered.
    await conn.execute("DROP INDEX IF EXISTS idx_messages_dedup_null_safe")
    await conn.execute("DROP INDEX IF EXISTS idx_messages_incoming_priv_dedup")
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_content_fallback ON messages(type,conversation_key,sender_timestamp)"
    )
    await conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wire_identity ON messages(type,conversation_key,wire_packet_id) WHERE wire_packet_id IS NOT NULL"
    )
    await conn.commit()
