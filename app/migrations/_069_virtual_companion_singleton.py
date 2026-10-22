"""Enforce one virtual Companion integration configuration."""

import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    # The type is introduced by this release, but keep upgrades deterministic
    # for pre-release databases that may have manually created duplicate rows.
    await conn.execute(
        """
        DELETE FROM fanout_configs
        WHERE type = 'virtual_companion_tcp'
          AND id NOT IN (
            SELECT id FROM fanout_configs
            WHERE type = 'virtual_companion_tcp'
            ORDER BY created_at, id
            LIMIT 1
          )
        """
    )
    await conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fanout_virtual_companion_singleton
        ON fanout_configs(type)
        WHERE type = 'virtual_companion_tcp'
        """
    )
    await conn.commit()
