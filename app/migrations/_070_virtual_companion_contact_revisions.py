"""Add durable contact revisions and deletion tombstones for Companion sync."""

import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    await conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS virtual_companion_contact_clock (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            revision INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO virtual_companion_contact_clock(singleton, revision)
        VALUES (1, MAX(1, CAST(strftime('%s', 'now') AS INTEGER)));

        CREATE TABLE IF NOT EXISTS virtual_companion_contact_changes (
            public_key TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            deleted INTEGER NOT NULL CHECK (deleted IN (0, 1))
        );
        INSERT OR IGNORE INTO virtual_companion_contact_changes(public_key, revision, deleted)
        SELECT lower(public_key),
               (SELECT revision FROM virtual_companion_contact_clock WHERE singleton = 1),
               0
        FROM contacts
        GROUP BY lower(public_key);

        CREATE INDEX IF NOT EXISTS idx_virtual_companion_contact_changes_revision
        ON virtual_companion_contact_changes(revision);

        CREATE TRIGGER IF NOT EXISTS trg_virtual_companion_contact_insert
        AFTER INSERT ON contacts BEGIN
            UPDATE virtual_companion_contact_clock
            SET revision = MAX(revision + 1, CAST(strftime('%s', 'now') AS INTEGER))
            WHERE singleton = 1;
            INSERT INTO virtual_companion_contact_changes(public_key, revision, deleted)
            SELECT lower(NEW.public_key), revision, 0
            FROM virtual_companion_contact_clock WHERE singleton = 1
            ON CONFLICT(public_key) DO UPDATE SET revision = excluded.revision, deleted = 0;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_virtual_companion_contact_update
        AFTER UPDATE ON contacts BEGIN
            UPDATE virtual_companion_contact_clock
            SET revision = MAX(revision + 1, CAST(strftime('%s', 'now') AS INTEGER))
            WHERE singleton = 1;
            INSERT INTO virtual_companion_contact_changes(public_key, revision, deleted)
            SELECT lower(NEW.public_key), revision, 0
            FROM virtual_companion_contact_clock WHERE singleton = 1
            ON CONFLICT(public_key) DO UPDATE SET revision = excluded.revision, deleted = 0;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_virtual_companion_contact_delete
        AFTER DELETE ON contacts BEGIN
            UPDATE virtual_companion_contact_clock
            SET revision = MAX(revision + 1, CAST(strftime('%s', 'now') AS INTEGER))
            WHERE singleton = 1;
            INSERT INTO virtual_companion_contact_changes(public_key, revision, deleted)
            SELECT lower(OLD.public_key), revision, 1
            FROM virtual_companion_contact_clock WHERE singleton = 1
            ON CONFLICT(public_key) DO UPDATE SET revision = excluded.revision, deleted = 1;
        END;
        """
    )
    await conn.commit()
