import aiosqlite
import pytest

from app.migrations import get_version, run_migrations, set_version
from tests.test_migrations.conftest import LATEST_SCHEMA_VERSION


@pytest.mark.asyncio
async def test_adds_confirmed_send_status_to_existing_messages():
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    try:
        await set_version(conn, 63)
        await conn.execute("""
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                conversation_key TEXT NOT NULL,
                text TEXT NOT NULL,
                received_at INTEGER NOT NULL,
                outgoing INTEGER DEFAULT 0
            )
        """)
        await conn.execute(
            "INSERT INTO messages (type, conversation_key, text, received_at, outgoing) "
            "VALUES ('PRIV', 'abc', 'hello', 1, 1)"
        )
        await conn.commit()

        assert await run_migrations(conn) == 1
        assert await get_version(conn) == LATEST_SCHEMA_VERSION

        cursor = await conn.execute("SELECT send_status FROM messages")
        row = await cursor.fetchone()
        assert row["send_status"] == "confirmed"
    finally:
        await conn.close()
