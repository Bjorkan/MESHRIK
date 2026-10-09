import aiosqlite
import pytest

from app.migrations import get_version, run_migrations, set_version
from tests.test_migrations.conftest import LATEST_SCHEMA_VERSION


@pytest.mark.asyncio
async def test_adds_and_backfills_read_message_cursors():
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    try:
        await set_version(conn, 64)
        await conn.executescript("""
            CREATE TABLE contacts (
                public_key TEXT PRIMARY KEY,
                last_read_at INTEGER
            );
            CREATE TABLE channels (
                key TEXT PRIMARY KEY,
                last_read_at INTEGER
            );
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                conversation_key TEXT NOT NULL,
                text TEXT NOT NULL,
                received_at INTEGER NOT NULL
            );
            INSERT INTO contacts (public_key, last_read_at) VALUES ('alice', 100);
            INSERT INTO channels (key, last_read_at) VALUES ('PUBLIC', 100);
            INSERT INTO messages (type, conversation_key, text, received_at)
                VALUES ('PRIV', 'alice', 'read dm', 100);
            INSERT INTO messages (type, conversation_key, text, received_at)
                VALUES ('PRIV', 'alice', 'unread dm', 101);
            INSERT INTO messages (type, conversation_key, text, received_at)
                VALUES ('CHAN', 'PUBLIC', 'read channel', 100);
            INSERT INTO messages (type, conversation_key, text, received_at)
                VALUES ('CHAN', 'PUBLIC', 'unread channel', 101);
        """)
        await conn.commit()

        assert await run_migrations(conn) == 1
        assert await get_version(conn) == LATEST_SCHEMA_VERSION

        contact = await (
            await conn.execute(
                "SELECT last_read_message_id FROM contacts WHERE public_key = 'alice'"
            )
        ).fetchone()
        channel = await (
            await conn.execute("SELECT last_read_message_id FROM channels WHERE key = 'PUBLIC'")
        ).fetchone()
        assert contact["last_read_message_id"] == 1
        assert channel["last_read_message_id"] == 3
    finally:
        await conn.close()
