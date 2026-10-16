import pytest

from app.repository import MessageRepository


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
    import json

    async with messages_repo.db.readonly() as conn:
        async with conn.execute("SELECT paths FROM messages WHERE id=?", (message_id,)) as cursor:
            recorded = await cursor.fetchone()
    assert json.loads(recorded["paths"])[0]["last_seen_at"] == 101
    assert last[0].rssi == -70 and last[0].snr == 5.0
    assert (await MessageRepository.get_by_id(message_id)).acked == 0
