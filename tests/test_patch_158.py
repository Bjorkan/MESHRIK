import json

import aiosqlite
import pytest

from app.migrations._068_bounded_message_paths import migrate
from app.repository import MessageRepository
from app.services.messages import reconcile_duplicate_message


@pytest.mark.asyncio
async def test_duplicate_route_updates_last_seen_without_inflating_echoes(test_db):
    from app.repository import messages as messages_repo

    async with messages_repo.db.tx() as conn:
        async with conn.execute(
            "INSERT INTO messages(type,conversation_key,text,outgoing,received_at,acked) "
            "VALUES('CHAN', ?, 'duplicate path', 1, 100, 0)",
            ("a" * 32,),
        ) as cursor:
            message_id = cursor.lastrowid
    first, inserted = await MessageRepository.add_path_with_status(
        message_id, "abcd", received_at=100, rssi=-80, snr=4.0
    )
    assert inserted and len(first) == 1
    for _ in range(200):
        last, inserted = await MessageRepository.add_path_with_status(
            message_id, "abcd", received_at=101, rssi=-70, snr=5.0
        )
        assert inserted is False
    assert len(last) == 1
    assert last[0].received_at == 100
    async with messages_repo.db.readonly() as conn:
        async with conn.execute("SELECT paths FROM messages WHERE id=?", (message_id,)) as cursor:
            recorded = await cursor.fetchone()
    assert json.loads(recorded["paths"])[0]["last_seen_at"] == 101
    assert last[0].rssi == -70 and last[0].snr == 5.0
    assert (await MessageRepository.get_by_id(message_id)).acked == 0


@pytest.mark.asyncio
async def test_ten_thousand_same_path_echoes_stay_bounded(test_db, captured_broadcasts):
    broadcasts, broadcast = captured_broadcasts
    message_id = await MessageRepository.create(
        msg_type="CHAN",
        text="storm",
        conversation_key="b" * 32,
        sender_timestamp=1_700_000_000,
        received_at=1_700_000_000,
        outgoing=True,
    )
    assert message_id is not None
    existing = await MessageRepository.get_by_id(message_id)
    assert existing is not None

    for _ in range(10_000):
        await reconcile_duplicate_message(
            existing_msg=existing,
            packet_id=None,
            path="aabb",
            received_at=1_700_000_001,
            path_len=2,
            broadcast_fn=broadcast,
        )

    stored = await MessageRepository.get_by_id(message_id)
    assert stored is not None
    assert stored.acked == 1
    assert stored.paths is not None and len(stored.paths) == 1
    assert len(broadcasts) == 1
    assert len(json.dumps(broadcasts[0], separators=(",", ":")).encode()) < 1_024


@pytest.mark.asyncio
async def test_path_migration_preserves_id_and_recent_unique_observations():
    conn = await aiosqlite.connect(":memory:")
    conn.row_factory = aiosqlite.Row
    try:
        await conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT NOT NULL, paths TEXT)"
        )
        paths = [
            {"path": f"{index:04x}", "path_len": 2, "received_at": 100 + index}
            for index in range(18)
        ]
        paths.insert(
            10,
            {"path": "0000", "path_len": 2, "received_at": 999, "rssi": -60},
        )
        await conn.execute(
            "INSERT INTO messages (id, text, paths) VALUES (?, ?, ?)",
            (73, "canonical", json.dumps(paths)),
        )
        await conn.commit()

        await migrate(conn)

        row = await (
            await conn.execute("SELECT id, text, paths FROM messages WHERE id=73")
        ).fetchone()
        assert row["id"] == 73
        assert row["text"] == "canonical"
        normalized = json.loads(row["paths"])
        assert len(normalized) == 16
        assert normalized[0] == paths[0]
        assert [entry["path"] for entry in normalized[1:]] == [
            f"{index:04x}" for index in range(3, 18)
        ]
    finally:
        await conn.close()
