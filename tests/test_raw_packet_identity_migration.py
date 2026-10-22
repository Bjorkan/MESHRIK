from hashlib import sha256
from sqlite3 import IntegrityError

import aiosqlite
import pytest

from app.migrations._067_canonical_raw_packet_identity import migrate
from app.path_utils import canonical_packet_digest


@pytest.mark.asyncio
async def test_canonical_identity_migration_preserves_rows_and_links():
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    packet = bytes([(2 << 2) | 1, 0]) + b"same-body"
    try:
        await conn.executescript("""
            CREATE TABLE raw_packets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                data BLOB NOT NULL,
                message_id INTEGER,
                payload_hash BLOB
            );
            CREATE UNIQUE INDEX idx_raw_packets_payload_hash
                ON raw_packets(payload_hash);
        """)
        await conn.executemany(
            "INSERT INTO raw_packets "
            "(id, timestamp, data, message_id, payload_hash) VALUES (?, ?, ?, ?, ?)",
            [
                (7, 1_700_000_001, packet, 41, sha256(b"legacy-a").digest()),
                (9, 1_700_000_002, packet, 42, sha256(b"legacy-b").digest()),
            ],
        )
        await conn.commit()

        await migrate(conn)

        rows = await (
            await conn.execute(
                "SELECT id, timestamp, data, message_id, payload_hash FROM raw_packets ORDER BY id"
            )
        ).fetchall()
        assert [(row["id"], row["timestamp"], row["message_id"]) for row in rows] == [
            (7, 1_700_000_001, 41),
            (9, 1_700_000_002, 42),
        ]
        assert all(bytes(row["data"]) == packet for row in rows)
        assert bytes(rows[0]["payload_hash"]) == canonical_packet_digest(packet)
        assert bytes(rows[1]["payload_hash"]) != bytes(rows[0]["payload_hash"])
        assert len(bytes(rows[1]["payload_hash"])) == 32

        with pytest.raises(IntegrityError):
            await conn.execute(
                "INSERT INTO raw_packets (timestamp, data, payload_hash) VALUES (?, ?, ?)",
                (1_700_000_003, packet, canonical_packet_digest(packet)),
            )
    finally:
        await conn.close()
