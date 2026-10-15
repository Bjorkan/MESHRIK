"""Upgrade raw packet identities without changing IDs or message links."""

from hashlib import sha256

import aiosqlite

from app.path_utils import canonical_packet_digest


async def migrate(conn: aiosqlite.Connection) -> None:
    await conn.execute("DROP INDEX IF EXISTS idx_raw_packets_payload_hash")
    cur = await conn.execute("SELECT id,data FROM raw_packets ORDER BY id")
    rows = await cur.fetchall()
    seen: set[bytes] = set()
    for row in rows:
        identity = canonical_packet_digest(bytes(row["data"]))
        if identity in seen:
            # Existing distinct rows are never deleted: preserve their stable
            # foreign-key links without synthesizing a vanished observation.
            identity = sha256(
                b"legacy-identity" + int(row["id"]).to_bytes(8, "big") + bytes(row["data"])
            ).digest()
        seen.add(identity)
        await conn.execute(
            "UPDATE raw_packets SET payload_hash=? WHERE id=?", (identity, row["id"])
        )
    await conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_packets_payload_hash ON raw_packets(payload_hash)"
    )
    await conn.commit()
