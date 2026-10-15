"""Bound existing path arrays while keeping canonical message IDs."""

import json

import aiosqlite


async def migrate(conn: aiosqlite.Connection) -> None:
    cur = await conn.execute("SELECT id,paths FROM messages WHERE paths IS NOT NULL")
    for message_id, encoded in await cur.fetchall():
        try:
            paths = json.loads(encoded)
        except (ValueError, TypeError):
            continue
        if not isinstance(paths, list) or len(paths) <= 16:
            continue
        unique = []
        seen = set()
        for entry in paths:
            if not isinstance(entry, dict):
                continue
            key = (entry.get("path"), entry.get("path_len"))
            if key not in seen:
                unique.append(entry)
                seen.add(key)
        if len(unique) > 16:
            unique = [unique[0]] + unique[-15:]
        await conn.execute(
            "UPDATE messages SET paths=? WHERE id=?", (json.dumps(unique), message_id)
        )
    await conn.commit()
