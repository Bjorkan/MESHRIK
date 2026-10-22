"""Add bounded durable idempotency reservations for virtual channel sends."""

import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    await conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS virtual_companion_channel_sends (
            identity_key TEXT NOT NULL,
            virtual_index INTEGER NOT NULL CHECK (virtual_index BETWEEN 0 AND 255),
            sender_timestamp INTEGER NOT NULL CHECK (sender_timestamp BETWEEN 0 AND 4294967295),
            text_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'uncertain')),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (identity_key, virtual_index, sender_timestamp, text_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_virtual_companion_channel_sends_created
        ON virtual_companion_channel_sends(created_at);
        """
    )
    await conn.commit()
