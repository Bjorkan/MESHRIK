"""Migration 072 adds the normalized contact-key lookup index."""

import aiosqlite
import pytest

from app.migrations._072_contact_key_lookup_index import migrate


@pytest.mark.asyncio
async def test_migration_adds_normalized_contact_key_index():
    conn = await aiosqlite.connect(":memory:")
    try:
        await conn.execute("CREATE TABLE contacts (public_key TEXT PRIMARY KEY)")
        await migrate(conn)

        cursor = await conn.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM contacts WHERE lower(public_key) = ?",
            ("ab" * 32,),
        )
        plan = " ".join(str(column) for row in await cursor.fetchall() for column in row)
        assert "idx_contacts_public_key_lower" in plan
    finally:
        await conn.close()
