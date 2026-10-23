"""Index normalized contact keys for bounded Companion point lookups."""

import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contacts_public_key_lower ON contacts(lower(public_key))"
    )
    await conn.commit()
